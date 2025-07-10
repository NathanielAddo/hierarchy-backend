import { Entity, Column, PrimaryGeneratedColumn, ManyToOne } from "typeorm";
import { Account } from "./account.entity";

@Entity( )
export class User {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column()
  firstName!: string;

  @Column()
  lastName!: string;

  @Column({ unique: true })
  email!: string;

  @Column()
  phone!: string;

  @Column()
  password!: string;

  @Column({ type: "varchar" })
  role!: "admin" | "user";

  @Column({ type: "varchar", nullable: true })
  adminType?: "limited" | "unlimited";

  @Column()
  accountId!: string;

  @ManyToOne(() => Account, (account) => account.users)
  account!: Account;
}