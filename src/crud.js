import { eq } from 'drizzle-orm';
import { db, pool } from './db.js';
import { demoUsers } from './schema.js';

async function main() {
  try {
    console.log('Performing CRUD operations...');

    const [newUser] = await db
      .insert(demoUsers)
      .values({
        name: 'Admin User',
        email: `admin-${Date.now()}@example.com`,
      })
      .returning();

    if (!newUser) {
      throw new Error('Failed to create user');
    }

    console.log('CREATE: New user created:', newUser);

    const [foundUser] = await db
      .select()
      .from(demoUsers)
      .where(eq(demoUsers.id, newUser.id));

    console.log('READ: Found user:', foundUser);

    const [updatedUser] = await db
      .update(demoUsers)
      .set({ name: 'Super Admin' })
      .where(eq(demoUsers.id, newUser.id))
      .returning();

    if (!updatedUser) {
      throw new Error('Failed to update user');
    }

    console.log('UPDATE: User updated:', updatedUser);

    await db.delete(demoUsers).where(eq(demoUsers.id, newUser.id));
    console.log('DELETE: User deleted.');
    console.log('CRUD operations completed successfully.');
  } catch (error) {
    console.error('Error performing CRUD operations:', error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
