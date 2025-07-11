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
  synchronize: false, // Auto-create tables in dev
  logging: true,
});

export const initializeDatabase = async () => {
  try {
    await AppDataSource.initialize();
    console.log("Database connection established");

    const accountRepository = AppDataSource.getRepository(Geo_Account);
    const userRepository = AppDataSource.getRepository(Geo_User);

    // Find or create account by name instead of ID
    let account = await accountRepository.findOne({ 
      where: { name: "Ministry of Education" }
    });
    
    if (!account) {
      account = accountRepository.create({
        name: "Ministry of Education",
        description: "Main account for admin access",
        type: "main",
        parentId: null,
        country: "Ghana"
      });
      await accountRepository.save(account);
    }

    // Admin user setup
    const adminEmail = process.env.ADMIN_EMAIL || "clickcomgh@gmail.com";
    const adminPassword = process.env.ADMIN_PASSWORD || "CLOCK@FACIAL";
    
    let adminUser = await userRepository.findOne({
      where: { email: adminEmail },
      relations: ["account"]
    });

    if (!adminUser) {
      const loginResponse = await axios.post(
        "https://db-api-v2.akwaabasoftware.com/clients/login",
        {
          phone_email: adminEmail,
          password: adminPassword,
        }
      );

      const { user } = loginResponse.data;
      adminUser = userRepository.create({
        id: uuidv4(), // Generate proper UUID
        firstName: user.firstname || "Daniel",
        lastName: user.surname || "Ansah",
        email: user.email,
        phone: user.phone || "0206007255",
        role: "admin",
        adminType: "unlimited",
        accountId: account.id, // Use the account's UUID
        account: account
      });
      await userRepository.save(adminUser);

      // Update account primary admin
      account.primaryAdminId = adminUser.id;
      await accountRepository.save(account);
    }

    console.log("Database initialization completed successfully");
  } catch (error) {
    console.error("Database initialization failed:", error);
    throw error;
  }
};