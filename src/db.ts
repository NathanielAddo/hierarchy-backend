import { DataSource } from "typeorm";
import { Account } from "./entities/account.entity";
import { User } from "./entities/user.entity";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as bcrypt from "bcrypt";

dotenv.config();

console.log("📦 Loaded Environment Variables:");
console.table({
  DB_HOST: process.env.DB_HOST,
  DB_PORT: process.env.DB_PORT,
  DB_USER: process.env.DB_USER,
  DB_PASSWORD: process.env.DB_PASSWORD ? '***' : undefined,
  DB_NAME: process.env.DB_NAME,
});

// Read the CA certificate file
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
  entities: [Account, User],
  migrations: ["dist/migrations/**/*.js"],
  synchronize: false, // Set to false in production
});

export const initializeDatabase = async () => {
  try {
    await AppDataSource.initialize();
    console.log("Database connection established");

    // Create hardcoded main account and admin
    const accountRepository = AppDataSource.getRepository(Account);
    const userRepository = AppDataSource.getRepository(User);

    // Check if main account exists
    let mainAccount = await accountRepository.findOne({ where: { type: "main" } });
    if (!mainAccount) {
      mainAccount = accountRepository.create({
        name: "Ministry of Education Head Quarters",
        type: "main",
        parentId: undefined,
        country: "Global",
      });
      await accountRepository.save(mainAccount);
      console.log("Created main account");
    }

    // Check if hardcoded admin exists
    const adminEmail = "superadmin@akwaaba.com";
    let admin = await userRepository.findOne({ where: { email: adminEmail } });
    if (!admin) {
      const hashedPassword = await bcrypt.hash("SuperAdmin123!", 10);
      admin = userRepository.create({
        id: "admin-1",
        firstName: "Super",
        lastName: "Admin",
        email: adminEmail,
        phone: "+1234567890",
        password: hashedPassword,
        role: "admin",
        adminType: "unlimited",
        accountId: mainAccount.id,
        account: mainAccount,
      });
      await userRepository.save(admin);
      console.log("Created hardcoded super admin");
    }
  } catch (error) {
    console.error("Database connection failed", error);
    process.exit(1);
  }
};