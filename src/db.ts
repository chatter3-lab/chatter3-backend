export class DB {
  constructor(private db: D1Database) {}

  async allUsers() {
    return await this.db.prepare("SELECT * FROM users").all();
  }

  async createUser(username: string) {
    return await this.db.prepare("INSERT INTO users (username) VALUES (?)").bind(username).run();
  }

  async allRooms() {
    return await this.db.prepare("SELECT * FROM rooms").all();
  }

  async createRoom(name: string, createdBy: number) {
    return await this.db.prepare("INSERT INTO rooms (name, created_by) VALUES (?, ?)").bind(name, createdBy).run();
  }
}
