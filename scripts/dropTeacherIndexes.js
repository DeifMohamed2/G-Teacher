const mongoose = require('mongoose');
require('dotenv').config();

async function dropIndexes() {
  try {
    await mongoose.connect(process.env.DATABASE_URL);
    console.log('Connected to MongoDB');
    
    const db = mongoose.connection.db;
    const collection = db.collection('teachers');
    
    // List all indexes
    const indexes = await collection.indexes();
    console.log('Current indexes:', indexes.map(i => i.name));
    
    // Indexes to drop (legacy/unused)
    const indexesToDrop = ['username_1', 'password_1', 'sessionToken_1', 'isActive_1_isVerified_1'];
    
    for (const indexName of indexesToDrop) {
      try {
        await collection.dropIndex(indexName);
        console.log(`Successfully dropped ${indexName} index`);
      } catch (err) {
        if (err.code === 27) {
          console.log(`Index ${indexName} does not exist`);
        } else {
          console.log(`Error dropping ${indexName}:`, err.message);
        }
      }
    }
    
    // List indexes again
    const newIndexes = await collection.indexes();
    console.log('Indexes after cleanup:', newIndexes.map(i => i.name));
    
    await mongoose.disconnect();
    console.log('Done!');
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

dropIndexes();
