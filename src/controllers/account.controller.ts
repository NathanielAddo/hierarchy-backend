import { AppDataSource } from "../db";
import { Geo_Account } from "../entities/account.entity";
import { Geo_User } from "../entities/user.entity";
import { ApiResponse, ApiError } from "../utils/apiResponse";
import axios from "axios";

interface WebSocket {
  send: (data: string) => void;
}

interface OldSystemAdmin {
  id: string;
  accountId: string;
  firstname: string;
  surname: string;
  email: string;
  phone: string;
}

interface OldSystemUser {
  id: string;
  accountId?: string;
  firstname?: string;
  surname: string;
  email: string;
  phone?: string;
}

export class AccountController {
  private accountRepository = AppDataSource.getRepository(Geo_Account);
  private userRepository = AppDataSource.getRepository(Geo_User);

  private async checkPermission(user: Geo_User, targetAccountId: string): Promise<boolean> {
    if (user.role !== "admin") return false;

    const targetAccount = await this.accountRepository.findOne({
      where: { id: targetAccountId },
      relations: ["parent"],
    });

    if (!targetAccount) return false;

    if (user.adminType === "unlimited" && user.account.type === "main") return true;

    const isPrimaryAdmin = targetAccount.primaryAdminId === user.id;
    const isAssignedToAccount = user.accountId === targetAccountId;

    if (!isPrimaryAdmin && !isAssignedToAccount) return false;

    if (user.adminType === "limited") return false;

    const hierarchy = ["main", "institutional", "regional", "district", "branch", "department"];
    const userAccountLevel = hierarchy.indexOf(user.account.type);
    const targetAccountLevel = hierarchy.indexOf(targetAccount.type);

    return userAccountLevel <= targetAccountLevel || targetAccount.parentId === user.accountId;
  }

  public async createAccount(ws: WebSocket, data: {
    name: string;
    description?: string;
    type: "institutional" | "regional" | "district" | "branch" | "department";
    parentId: string;
    country: string;
    primaryAdminId: string;
    adminType: "limited" | "unlimited";
    adminIds: string[];
    userIds: string[];
  }, user: Geo_User) {
    try {
      if (user.account.type !== "main" || user.adminType !== "unlimited") {
        throw new ApiError(403, "Only main account admins with unlimited privileges can create accounts");
      }

      const { name, description, type, parentId, country, primaryAdminId, adminType, adminIds, userIds } = data;

      const parent = await this.accountRepository.findOne({ where: { id: parentId } });
      if (!parent) throw new ApiError(404, "Parent account not found");

      const primaryAdmin = await this.userRepository.findOne({ 
        where: { id: primaryAdminId, role: "admin", accountId: user.accountId } 
      });
      if (!primaryAdmin) throw new ApiError(404, "Primary admin not found or not in your organization");

      const newAccount = this.accountRepository.create({
        name,
        description,
        type,
        parentId,
        country,
        parent,
        primaryAdminId,
      });

      await this.accountRepository.save(newAccount);

      primaryAdmin.accountId = newAccount.id;
      primaryAdmin.account = newAccount;
      primaryAdmin.adminType = adminType;
      await this.userRepository.save(primaryAdmin);

      const admins: Geo_User[] = await this.userRepository.findByIds(adminIds);
      const users: Geo_User[] = await this.userRepository.findByIds(userIds);

      for (const admin of admins) {
        if (admin.role !== "admin" || admin.accountId !== user.accountId || admin.id === primaryAdminId) continue;
        admin.accountId = newAccount.id;
        admin.account = newAccount;
        admin.adminType = admin.adminType || "limited";
        await this.userRepository.save(admin);
      }

      for (const user of users) {
        if (user.role !== "user" || user.accountId !== user.accountId) continue;
        user.accountId = newAccount.id;
        user.account = newAccount;
        await this.userRepository.save(user);
      }

      ws.send(
        JSON.stringify(
          new ApiResponse(201, "Account created successfully", {
            account: newAccount,
            primaryAdmin,
            assignedAdmins: admins,
            assignedUsers: users,
          })
        )
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to create account";
      ws.send(JSON.stringify(new ApiError(500, message)));
    }
  }

  public async createUser(ws: WebSocket, data: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    role: "admin" | "user";
    adminType?: "limited" | "unlimited";
    accountId: string;
  }, user: Geo_User) {
    try {
      if (user.account.type !== "main" || user.adminType !== "unlimited") {
        throw new ApiError(403, "Only main account admins with unlimited privileges can create users");
      }

      const { firstName, lastName, email, phone, role, adminType, accountId } = data;

      const account = await this.accountRepository.findOne({ where: { id: accountId } });
      if (!account) throw new ApiError(404, "Account not found");

      const existingUser = await this.userRepository.findOne({ where: { email } });
      if (existingUser) throw new ApiError(409, "Email already exists");

      const newUser = this.userRepository.create({
        firstName,
        lastName,
        email,
        phone,
        role,
        adminType: role === "admin" ? adminType : undefined,
        accountId,
        account,
      });

      await this.userRepository.save(newUser);

      ws.send(
        JSON.stringify(
          new ApiResponse(201, `${role.charAt(0).toUpperCase() + role.slice(1)} created successfully`, newUser)
        )
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to create user";
      ws.send(JSON.stringify(new ApiError(500, message)));
    }
  }

  public async assignUsers(ws: WebSocket, data: { userIds: string[]; accountId: string }, user: Geo_User) {
    try {
      if (!(await this.checkPermission(user, data.accountId))) {
        throw new ApiError(403, "Insufficient permissions to assign users to this account");
      }

      const account = await this.accountRepository.findOne({ where: { id: data.accountId } });
      if (!account) throw new ApiError(404, "Account not found");

      const mainAccountId = user.account.type === "main" ? user.accountId : (await this.getMainAccount(user.accountId))?.id;
      const usersToAssign: Geo_User[] = await this.userRepository.findByIds(data.userIds);

      for (const userToAssign of usersToAssign) {
        if (userToAssign.accountId !== mainAccountId && userToAssign.accountId !== user.accountId) continue;
        userToAssign.accountId = account.id;
        userToAssign.account = account;
        await this.userRepository.save(userToAssign);
      }

      ws.send(
        JSON.stringify(
          new ApiResponse(200, "Users assigned successfully", {
            accountId: account.id,
            assignedUsers: usersToAssign,
          })
        )
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to assign users";
      ws.send(JSON.stringify(new ApiError(500, message)));
    }
  }

  private async getMainAccount(accountId: string): Promise<Geo_Account | null> {
    let account = await this.accountRepository.findOne({ where: { id: accountId }, relations: ["parent"] });
    while (account && account.parentId) {
      account = await this.accountRepository.findOne({ where: { id: account.parentId }, relations: ["parent"] });
    }
    return account;
  }

  public async getAccounts(ws: WebSocket, user: Geo_User) {
    try {
      let accounts;
      if (user.account.type === "main" && user.adminType === "unlimited") {
        accounts = await this.accountRepository.find({ relations: ["parent", "users"] });
      } else {
        const hierarchy = ["main", "institutional", "regional", "district", "branch", "department"];
        const userAccountLevel = hierarchy.indexOf(user.account.type);
        accounts = await this.accountRepository
          .createQueryBuilder("account")
          .leftJoinAndSelect("account.parent", "parent")
          .leftJoinAndSelect("account.users", "users")
          .where("account.type IN (:...types)", {
            types: hierarchy.slice(userAccountLevel),
          })
          .orWhere("account.id = :userAccountId", { userAccountId: user.accountId })
          .orWhere("account.primaryAdminId = :userId", { userId: user.id })
          .getMany();
      }

      ws.send(JSON.stringify(new ApiResponse(200, "Accounts retrieved successfully", accounts)));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to retrieve accounts";
      ws.send(JSON.stringify(new ApiError(500, message)));
    }
  }

  public async getOrganizationUsers(ws: WebSocket, user: Geo_User, token: string) {
    try {
      if (user.role !== "admin") {
        throw new ApiError(403, "Only admins can view organization users");
      }

      const mainAccountId = user.account.type === "main" ? user.accountId : (await this.getMainAccount(user.accountId))?.id;
      if (!mainAccountId) throw new ApiError(404, "Main account not found");

      const adminsResponse = await axios.get<OldSystemAdmin[]>("https://db-api-v2.akwaabasoftware.com/clients/user", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const admins = adminsResponse.data.filter(admin => `main-${admin.accountId}` === mainAccountId);

      const usersResponse = await axios.get<OldSystemUser[]>("https://db-api-v2.akwaabasoftware.com/attendance/meeting-event/attendance", {
        headers: { Authorization: `Bearer ${token}` },
        params: { selectAllSchedules: true },
      });
      const remoteUsers = usersResponse.data.filter(user => `main-${user.accountId}` === mainAccountId);

      const mainAccount = await this.accountRepository.findOne({ where: { id: mainAccountId } });
      if (!mainAccount) throw new ApiError(404, "Main account not found");

      const localUsers = await this.userRepository.find({
        where: { accountId: mainAccountId },
        relations: ["account"],
      });

      const subAccounts = await this.accountRepository.find({
        where: { parentId: user.accountId },
        relations: ["users"],
      });

      const subAccountUsers = await this.userRepository.find({
        where: subAccounts.map(acc => ({ accountId: acc.id })),
        relations: ["account"],
      });

      ws.send(
        JSON.stringify(
          new ApiResponse(200, "Organization users retrieved successfully", {
            admins: admins.map(admin => ({
              id: `admin-${admin.id}`,
              firstName: admin.firstname,
              lastName: admin.surname,
              email: admin.email,
              phone: admin.phone,
              role: "admin",
              adminType: "unlimited",
              accountId: mainAccountId,
              accountName: user.account.name,
              accountType: user.account.type,
            })),
            users: remoteUsers.map(user => ({
              id: `user-${user.id}`,
              firstName: user.firstname || "Unknown",
              lastName: user.surname || "User",
              email: user.email,
              phone: user.phone || "N/A",
              role: "user",
              accountId: mainAccountId,
              accountName: mainAccount.name,
              accountType: mainAccount.type,
            })),
            localUsers: [...localUsers, ...subAccountUsers].map(user => ({
              id: user.id,
              firstName: user.firstName,
              lastName: user.lastName,
              email: user.email,
              phone: user.phone,
              role: user.role,
              adminType: user.adminType,
              accountId: user.accountId,
              accountName: user.account.name,
              accountType: user.account.type,
            })),
          })
        )
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to retrieve organization users";
      ws.send(JSON.stringify(new ApiError(500, message)));
    }
  }
}