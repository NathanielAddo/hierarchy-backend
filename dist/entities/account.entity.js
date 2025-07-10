"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Geo_Account = void 0;
const typeorm_1 = require("typeorm");
const user_entity_1 = require("./user.entity");
let Geo_Account = class Geo_Account {
};
exports.Geo_Account = Geo_Account;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)("uuid"),
    __metadata("design:type", String)
], Geo_Account.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], Geo_Account.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "text", nullable: true }),
    __metadata("design:type", Object)
], Geo_Account.prototype, "description", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "varchar" }),
    __metadata("design:type", String)
], Geo_Account.prototype, "type", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "uuid", nullable: true }),
    __metadata("design:type", Object)
], Geo_Account.prototype, "parentId", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], Geo_Account.prototype, "country", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: "varchar", length: 36, nullable: true }),
    __metadata("design:type", Object)
], Geo_Account.prototype, "primaryAdminId", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => Geo_Account, (account) => account.children, { nullable: true }),
    __metadata("design:type", Object)
], Geo_Account.prototype, "parent", void 0);
__decorate([
    (0, typeorm_1.OneToMany)(() => Geo_Account, (account) => account.parent),
    __metadata("design:type", Array)
], Geo_Account.prototype, "children", void 0);
__decorate([
    (0, typeorm_1.OneToMany)(() => user_entity_1.Geo_User, (user) => user.account),
    __metadata("design:type", Array)
], Geo_Account.prototype, "users", void 0);
exports.Geo_Account = Geo_Account = __decorate([
    (0, typeorm_1.Entity)()
], Geo_Account);
