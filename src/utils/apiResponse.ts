export class ApiResponse {
  constructor(
    public status: number,
    public message: string,
    public data?: any
  ) {}
}

export class ApiError {
  constructor(
    public status: number,
    public message: string
  ) {}
}