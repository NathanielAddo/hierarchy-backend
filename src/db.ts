import { DataSource } from "typeorm";
import { Geo_Account } from "./entities/account.entity";
import { Geo_User } from "./entities/user.entity";
import * as dotenv from "dotenv";
import * as fs from "fs";
import axios from "axios";

dotenv.config();

console.log("📦 Loaded Environment Variables:");
console.table({
  DB_HOST: process.env.DB_HOST,
  DB_PORT: process.env.DB_PORT,
  DB_USER: process.env.DB_USER,
  DB_PASSWORD: process.env.DB_PASSWORD ? '***' : undefined,
  DB_NAME: process.env.DB_NAME,
});

const caCert = fs.existsSync("ca-certificate.crt")
  ? fs.readFileSync("ca-certificate.crt")
  : undefined;

export const AppDataSource = new DataSource({
  type: "postgres",
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || "defaultdb",
  ssl: caCert
    ? {
        rejectUnauthorized: true,
        ca: caCert,
      }
    : false,
  entities: [Geo_Account, Geo_User],
  migrations: ["dist/migrations/**/*.js"],
  synchronize: true, // Set to false in production
});

export const initializeDatabase = async () => {
  try {
    await AppDataSource.initialize();
    console.log("Database connection established");

    // Fetch system-level admin token
    const adminEmail = process.env.ADMIN_EMAIL || "clickcomgh@gmail.com";
    const adminPassword = process.env.ADMIN_PASSWORD || "CLOCK@FACIAL";
    if (!adminEmail || !adminPassword) throw new Error("ADMIN_EMAIL or ADMIN_PASSWORD not set in .env");

    const loginResponse = await axios.post("https://db-api-v2.akwaabasoftware.com/clients/login", {
      phone_email: adminEmail,
      password: adminPassword,
    });
    const adminToken = loginResponse.data.token;
    if (!adminToken) throw new Error("Failed to obtain ADMIN_TOKEN");
    console.log("Generated ADMIN_TOKEN:", adminToken);

    // Fetch admins
    const adminsResponse = await axios.get("https://db-api-v2.akwaabasoftware.com/clients/user", {
      headers: { Authorization: `Token ${adminToken}` },
    });
    console.log("Admins response:", adminsResponse.data);
    const admins = adminsResponse.data;

    // Fetch users
    const schedulesResponse = await axios.get("https://db-api-v2.akwaabasoftware.com/attendance/meeting-event/attendance", {
      headers: { Authorization: `Token ${adminToken}` },
      params: { selectAllSchedules: true },
    });
    console.log("Users response:", schedulesResponse.data);
    const users = schedulesResponse.data;

    const accountRepository = AppDataSource.getRepository(Geo_Account);
    const userRepository = AppDataSource.getRepository(Geo_User);

    // Create main account and admins
    for (const admin of admins) {
      let mainAccount = await accountRepository.findOne({ where: { id: `main-${admin.accountId}` } });
      if (!mainAccount) {
        mainAccount = accountRepository.create({
          id: `main-${admin.accountId}`,
          name: "Ministry of Education",
          description: "Main Branch",
          type: "main",
          parentId: null,
          country: "Ghana",
          primaryAdminId: `admin-${admin.id}`,
        });
        await accountRepository.save(mainAccount);
        console.log(`Created main account for organization ${admin.accountId}`);
      }

      let adminUser = await userRepository.findOne({ where: { email: admin.email } });
      if (!adminUser) {
        adminUser = userRepository.create({
          id: `admin-${admin.id}`,
          firstName: admin.firstname,
          lastName: admin.surname,
          email: admin.email,
          phone: admin.phone,
          role: "admin",
          adminType: "unlimited",
          accountId: mainAccount.id,
          account: mainAccount,
        });
        await userRepository.save(adminUser);
        console.log(`Created main account admin ${admin.email}`);
      }
    }

    // Migrate users
    for (const user of users) {
      const mainAccount = await accountRepository.findOne({ where: { id: `main-${user.accountId}` } });
      if (!mainAccount) continue;

      let existingUser = await userRepository.findOne({ where: { email: user.email } });
      if (!existingUser) {
        existingUser = userRepository.create({
          id: `user-${user.id}`,
          firstName: user.firstname || "Unknown",
          lastName: user.surname || "User",
          email: user.email,
          phone: user.phone || "N/A",
          role: "user",
          accountId: mainAccount.id,
          account: mainAccount,
        });
        await userRepository.save(existingUser);
        console.log(`Created user ${user.email} for account ${mainAccount.id}`);
      }
    }
  } catch (error) {
    console.error("Database initialization or migration failed:", error);
    if (axios.isAxiosError(error)) {
      console.error("Axios error details:", {
        status: error.response?.status,
        data: error.response?.data,
        headers: error.response?.headers,
      });
    }
    process.exit(1);
  }
};