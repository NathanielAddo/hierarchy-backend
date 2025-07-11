import { DataSource } from "typeorm";
import { Geo_Account } from "./entities/account.entity";
import { Geo_User } from "./entities/user.entity";
import * as dotenv from "dotenv";
import * as fs from "fs";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

console.log("📦 Loaded Environment Variables:");
console.table({
  DB_HOST: process.env.DB_HOST,
  DB_PORT: process.env.DB_PORT,
  DB_USER: process.env.DB_USER,
  DB_PASSWORD: process.env.DB_PASSWORD ? "***" : undefined,
  DB_NAME: process.env.DB_NAME,
  ADMIN_EMAIL: process.env.ADMIN_EMAIL,
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
  synchronize: process.env.NODE_ENV !== "production", // Auto-create tables in dev
  logging: true,
});

export const initializeDatabase = async () => {
  try {
    // Initialize database connection
    await AppDataSource.initialize();
    console.log("Database connection established");

    const accountRepository = AppDataSource.getRepository(Geo_Account);
    const userRepository = AppDataSource.getRepository(Geo_User);

    // Ensure the account exists (accountId: 180 from curl response)
    const accountId = "180"; // Use string to match Geo_Account.id type
    let account = await accountRepository.findOne({ where: { id: accountId } });
    if (!account) {
      account = accountRepository.create({
        id: accountId,
        name: "Ministry of Education",
        description: "Main account for admin access",
        type: "main",
        parentId: null,
        country: "Ghana",
        primaryAdminId: null, // Will be set after user creation
      });
      await accountRepository.save(account);
      console.log("Created account:", account.id);
    }

    // Ensure admin user exists
    const adminEmail = process.env.ADMIN_EMAIL || "clickcomgh@gmail.com";
    const adminPassword = process.env.ADMIN_PASSWORD || "CLOCK@FACIAL";
    if (!adminEmail || !adminPassword) {
      throw new Error("ADMIN_EMAIL or ADMIN_PASSWORD not set in .env");
    }

    let adminUser = await userRepository.findOne({
      where: { email: adminEmail, role: "admin" },
      relations: ["account"],
    });
    if (!adminUser) {
      // Verify credentials with external API
      const loginResponse = await axios.post(
        "https://db-api-v2.akwaabasoftware.com/clients/login",
        {
          phone_email: adminEmail,
          password: adminPassword,
        }
      );
      console.log("External API response:", loginResponse.data);

      const { user } = loginResponse.data;
      if (user.email !== adminEmail) {
        throw new Error("External API user email does not match ADMIN_EMAIL");
      }

      adminUser = userRepository.create({
        id: user.id.toString(), // From curl: id: 296
        firstName: user.firstname || "Daniel",
        lastName: user.surname || "Ansah",
        email: user.email,
        phone: user.phone || "0206007255",
        role: "admin",
        adminType: "unlimited",
        accountId: accountId,
        account: account,
      });
      await userRepository.save(adminUser);
      console.log("Created admin user:", adminUser.email);

      // Update account with primaryAdminId
      account.primaryAdminId = adminUser.id;
      await accountRepository.save(account);
      console.log("Updated account with primaryAdminId:", account.id);
    } else {
      console.log("Admin user already exists:", adminUser.email);
    }

    console.log("Database initialization completed successfully");
  } catch (error) {
    console.error("Database initialization failed:", error);
    if (axios.isAxiosError(error)) {
      console.error("Axios error details:", {
        status: error.response?.status,
        data: error.response?.data,
      });
    }
    throw error;
  }
};