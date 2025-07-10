import { Entity, Column, PrimaryGeneratedColumn, ManyToOne, OneToMany } from "typeorm";
import { User } from "./user.entity";

@Entity()
export class Account {
  @PrimaryGeneratedColumn("uuid")
  id?: string;

  @Column()
  name?: string;

  @Column({ type: "varchar" })
  type?: "main" | "institutional" | "regional" | "district" | "branch" | "department";

  @Column({ nullable: true })
  parentId?: string;

  @ManyToOne(() => Account, { nullable: true })
  parent?: Account;

  @OneToMany(() => Account, (account) => account.parent)
  children?: Account[];

  @Column()
  country?: string;

  @OneToMany(() => User, (user) => user.account)
  users?: User[];
}