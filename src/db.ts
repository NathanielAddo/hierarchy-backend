import { DataSource } from "typeorm";
import { Geo_Account } from "./entities/account.entity";
import { Geo_User } from "./entities/user.entity";
import * as dotenv from "dotenv";
import * as fs from "fs";
import axios, { AxiosError } from "axios";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

console.log("📦 Loaded Environment Variables:");
console.table({
  DB_HOST: process.env.DB_HOST,
  DB_PORT: process.env.DB_PORT,
  DB_USER: process.env.DB_USER,
  DB_PASSWORD: process.env.DB_PASSWORD ? "***" : undefined,
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
  synchronize: false,
});

export const initializeDatabase = async () => {
  try {
    // Initialize database connection
    await AppDataSource.initialize();
    console.log("Database connection established");

    // Fetch system-level admin token
    const adminEmail = process.env.ADMIN_EMAIL || "clickcomgh@gmail.com";
    const adminPassword = process.env.ADMIN_PASSWORD || "CLOCK@FACIAL";
    if (!adminEmail || !adminPassword) {
      throw new Error("ADMIN_EMAIL or ADMIN_PASSWORD not set in .env");
    }

    const loginResponse = await axios.post(
      "https://db-api-v2.akwaabasoftware.com/clients/login",
      {
        phone_email: adminEmail,
        password: adminPassword,
      }
    );
    const adminToken = loginResponse.data.token;
    if (!adminToken) {
      throw new Error("Failed to obtain ADMIN_TOKEN");
    }
    console.log("Generated ADMIN_TOKEN:", adminToken);

    // Fetch admins
    const adminsResponse = await axios.get(
      "https://db-api-v2.akwaabasoftware.com/clients/user",
      {
        headers: { Authorization: `Token ${adminToken}` },
      }
    );
    console.log("Admins response:", JSON.stringify(adminsResponse.data, null, 2));
    const admins = adminsResponse.data.results || adminsResponse.data;

    // Fetch meetingEventId dynamically
    let users = [];
    try {
      const eventsResponse = await axios.get(
        "https://db-api-v2.akwaabasoftware.com/attendance/meeting-event",
        {
          headers: { Authorization: `Token ${adminToken}` },
        }
      );
      const meetingEventId = eventsResponse.data.results?.[0]?.id;
      if (!meetingEventId) {
        throw new Error("No meeting events found");
      }

      console.log("Fetching schedules with params:", {
        isRecuring: "both",
        length: 100000,
        branchId: 1,
      });
      const schedulesResponse = await axios.get(
        "https://db-api-v2.akwaabasoftware.com/attendance/meeting-event/schedule",
        {
          headers: { Authorization: `Token ${adminToken}` },
          params: {
            isRecuring: "both",
            length: 100000,
            branchId: 1,
          },
        }
      );
      console.log("Schedules response:", JSON.stringify(schedulesResponse.data, null, 2));
      users = schedulesResponse.data.results || schedulesResponse.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.warn(
          "Failed to fetch schedules, skipping schedule migration:",
          error.response?.data || error.message
        );
      } else {
        console.warn(
          "Failed to fetch schedules, skipping schedule migration:",
          (error as Error).message || "Unknown error"
        );
      }
    }

    const accountRepository = AppDataSource.getRepository(Geo_Account);
    const userRepository = AppDataSource.getRepository(Geo_User);

    // Create main account and admins
    for (const admin of admins) {
      let mainAccount = await accountRepository.findOne({
        where: { id: admin.accountId ? uuidv4() : admin.accountId },
      });
      if (!mainAccount) {
        mainAccount = accountRepository.create({
          id: uuidv4(),
          name: "Ministry of Education",
          description: "Main Branch",
          type: "main",
          parentId: null,
          country: "Ghana",
          primaryAdminId: uuidv4(),
        });
        await accountRepository.save(mainAccount);
        console.log(`Created main account for organization ${admin.accountId || mainAccount.id}`);
      }

      let adminUser = await userRepository.findOne({ where: { email: admin.email } });
      if (!adminUser) {
        adminUser = userRepository.create({
          id: uuidv4(),
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
      const mainAccount = await accountRepository.findOne({
        where: { id: user.accountId || user.branchId },
      });
      if (!mainAccount) {
        console.warn(`No main account found for user ${user.email || user.id}, skipping`);
        continue;
      }

      let existingUser = await userRepository.findOne({ where: { email: user.email } });
      if (!existingUser) {
        existingUser = userRepository.create({
          id: uuidv4(),
          firstName: user.firstname || "Unknown",
          lastName: user.surname || "User",
          email: user.email || `user-${user.id}@example.com`,
          phone: user.phone || "N/A",
          role: "user",
          accountId: mainAccount.id,
          account: mainAccount,
        });
        await userRepository.save(existingUser);
        console.log(`Created user ${existingUser.email} for account ${mainAccount.id}`);
      }
    }

    console.log("Database initialization and migration completed successfully");
  } catch (error) {
    console.error("Database initialization or migration failed:", error);
    if (axios.isAxiosError(error)) {
      console.error("Axios error details:", {
        status: error.response?.status,
        data: error.response?.data,
        headers: error.response?.headers,
      });
    }
    if (error instanceof Error && error.message.includes("Database connection")) {
      process.exit(1);
    }
  }
};