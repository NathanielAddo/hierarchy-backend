"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApiError = exports.ApiResponse = void 0;
class ApiResponse {
    constructor(status, message, data) {
        this.status = status;
        this.message = message;
        this.data = data;
    }
}
exports.ApiResponse = ApiResponse;
class ApiError {
    constructor(status, message) {
        this.status = status;
        this.message = message;
    }
}
exports.ApiError = ApiError;
