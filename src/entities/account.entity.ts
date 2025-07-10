import { Entity, Column, PrimaryGeneratedColumn, ManyToOne, OneToMany } from "typeorm";
import { Geo_User } from "./user.entity";

@Entity()
export class Geo_Account {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column()
  name!: string;

  @Column({ type: "text", nullable: true })
  description!: string | null;

  @Column({ type: "varchar" })
  type!: string;

  @Column({ type: "uuid", nullable: true })
  parentId!: string | null;

  @Column()
  country!: string;

  @Column({ type: "varchar", length: 36, nullable: true })
  primaryAdminId!: string | null;

  @ManyToOne(() => Geo_Account, (account) => account.children, { nullable: true })
  parent!: Geo_Account | null;

  @OneToMany(() => Geo_Account, (account) => account.parent)
  children!: Geo_Account[];

  @OneToMany(() => Geo_User, (user) => user.account)
  users!: Geo_User[];
}