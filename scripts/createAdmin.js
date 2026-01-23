const mongoose = require('mongoose');
const dotenv = require('dotenv');
const readline = require('readline');
const path = require('path');
const Admin = require('../models/Admin');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

async function createAdmin() {
  try {
    const dbURI = process.env.DATABASE_URL;
    if (!dbURI) {
      console.error('Error: DATABASE_URL not found in .env file');
      process.exit(1);
    }

    console.log('Connecting to database...');
    await mongoose.connect(dbURI);
    console.log('Connected successfully.');

    console.log('\n--- Create New Admin User ---');
    
    const userName = await question('Enter Username: ');
    const phoneNumber = await question('Enter Phone Number: ');
    const email = await question('Enter Email (optional): ');
    const password = await question('Enter Password: ');
    
    let role = await question('Enter Role (admin/superAdmin) [default: admin]: ');
    if (!role) role = 'admin';
    if (!['admin', 'superAdmin'].includes(role)) {
      console.log('Invalid role. Defaulting to admin.');
      role = 'admin';
    }

    // Check if admin already exists
    const existingAdmin = await Admin.findOne({ phoneNumber });
    if (existingAdmin) {
      console.error('\nError: An admin with this phone number already exists.');
      process.exit(1);
    }

    const newAdmin = new Admin({
      userName,
      phoneNumber,
      email,
      password,
      role
    });

    await newAdmin.save();
    console.log(`\nSuccess: Admin user "${userName}" created successfully!`);

  } catch (error) {
    console.error('\nError creating admin:', error.message);
  } finally {
    mongoose.connection.close();
    rl.close();
  }
}

createAdmin();
