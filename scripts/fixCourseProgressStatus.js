/**
 * Script to fix inconsistencies between course enrollment status and progress percentage.
 * 
 * This script will:
 * 1. Find all users with enrolled courses
 * 2. For each enrollment, check if status matches progress
 * 3. Fix any inconsistencies:
 *    - If progress < 100 but status is 'completed', set status to 'active'
 *    - If progress = 100 but status is not 'completed', set status to 'completed'
 * 
 * Run with: node scripts/fixCourseProgressStatus.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

async function fixCourseProgressStatus() {
    console.log('🔧 Starting course progress status fix...\n');

    try {
        // Connect to database
        await mongoose.connect(process.env.DATABASE_URL, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        console.log('✅ Connected to database\n');

        // Find all users with enrolled courses
        const users = await User.find({
            'enrolledCourses.0': { $exists: true }
        });

        console.log(`📊 Found ${users.length} users with enrolled courses\n`);

        let totalFixed = 0;
        let totalChecked = 0;

        for (const user of users) {
            let userModified = false;

            for (const enrollment of user.enrolledCourses) {
                totalChecked++;
                const progress = enrollment.progress || 0;
                const currentStatus = enrollment.status;
                const expectedStatus = progress === 100 ? 'completed' : 'active';

                if (currentStatus !== expectedStatus) {
                    console.log(`[${user.Username || user._id}] Course ${enrollment.course}: Status "${currentStatus}" -> "${expectedStatus}" (progress: ${progress}%)`);
                    enrollment.status = expectedStatus;
                    userModified = true;
                    totalFixed++;
                }
            }

            if (userModified) {
                user.markModified('enrolledCourses');
                await user.save();
            }
        }

        console.log(`\n✅ Fix complete!`);
        console.log(`   Checked: ${totalChecked} enrollments`);
        console.log(`   Fixed: ${totalFixed} inconsistencies`);

    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('\n🔌 Disconnected from database');
    }
}

fixCourseProgressStatus();
