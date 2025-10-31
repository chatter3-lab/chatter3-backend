export class DB {
  private db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async allUsers() {
    try {
      return await this.db.prepare(
        "SELECT * FROM users"
      ).all();
    } catch (error) {
      console.error('Error fetching users:', error);
      throw error;
    }
  }

  async createUser(username: string) {
    try {
      const id = crypto.randomUUID();
      return await this.db.prepare(
        "INSERT INTO users (id, username, email) VALUES (?, ?, ?)"
      ).run(id, username, `${username}@example.com`);
    } catch (error) {
      console.error('Error creating user:', error);
      throw error;
    }
  }

  async getUserById(id: string) {
    try {
      return await this.db.prepare(
        "SELECT * FROM users WHERE id = ?"
      ).bind(id).first();
    } catch (error) {
      console.error('Error fetching user by id:', error);
      throw error;
    }
  }
}