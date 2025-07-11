import { Entity, Column, PrimaryColumn, ManyToOne } from "typeorm";
import { Geo_Account } from "./account.entity";

@Entity()
export class Geo_User {
  @PrimaryColumn('uuid', { default: () => 'uuid_generate_v4()' })
  id!: string;

  @Column()
  firstName!: string;

  @Column()
  lastName!: string;

  @Column({ unique: true })
  email!: string;

  @Column()
  phone!: string;

  @Column({ type: "varchar" })
  role!: "admin" | "user";

  @Column({ type: "varchar", nullable: true })
  adminType?: "limited" | "unlimited";

  @Column({ type: "uuid" })
  accountId!: string;

  @ManyToOne(() => Geo_Account, (account) => account.users)
  account!: Geo_Account;
}