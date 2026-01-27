const mongoose = require('mongoose');
const User = require('../models/User');
const Submission = require('../models/Submission');
const Topic = require('../models/Topic');
require('dotenv').config();

/**
 * Script to sync all existing submissions with student contentProgress
 * This ensures that all submissions are properly reflected in the contentProgress array
 */
async function syncSubmissionsToContentProgress() {
  try {
    console.log('🔄 Starting submission sync to contentProgress...\n');

    // Connect to MongoDB
    await mongoose.connect(process.env.DATABASE_URL);
    console.log('✅ Connected to MongoDB\n');

    // Get all submissions
    const submissions = await Submission.find({})
      .populate('student', 'firstName lastName username')
      .sort({ createdAt: -1 });

    console.log(`📊 Found ${submissions.length} submissions to process\n`);

    let syncedCount = 0;
    let errorCount = 0;
    const errors = [];

    for (const submission of submissions) {
      try {
        if (!submission.student) {
          console.warn(`⚠️  Skipping submission ${submission._id} - student not found`);
          continue;
        }

        const student = await User.findById(submission.student._id);
        
        if (!student) {
          console.warn(`⚠️  Skipping submission ${submission._id} - student ${submission.student._id} not found in DB`);
          errorCount++;
          continue;
        }

        // Find the enrollment
        const enrollment = student.enrolledCourses.find(
          (e) => e.course && e.course.toString() === submission.course.toString()
        );

        if (!enrollment) {
          console.warn(`⚠️  Skipping submission ${submission._id} - enrollment not found for course ${submission.course}`);
          errorCount++;
          continue;
        }

        // Initialize contentProgress if needed
        if (!enrollment.contentProgress) {
          enrollment.contentProgress = [];
        }

        // Find or create contentProgress entry
        let contentProgress = enrollment.contentProgress.find(
          (cp) =>
            cp.contentId && cp.contentId.toString() === submission.contentId.toString() &&
            cp.topicId && cp.topicId.toString() === submission.topic.toString()
        );

        // Determine completion status and percentage based on submission status
        let completionStatus = 'not_started';
        let progressPercentage = 0;
        let score = null;
        let completedAt = null;

        if (submission.status === 'graded' && submission.grade && submission.grade.score !== null) {
          // Graded - mark as completed with score
          completionStatus = 'completed';
          progressPercentage = 100;
          score = (submission.grade.score / submission.grade.maxScore) * 100;
          completedAt = submission.grade.gradedAt || new Date();
        } else if (['submitted', 'late'].includes(submission.status)) {
          // Submitted but not graded yet - mark as in_progress
          completionStatus = 'in_progress';
          progressPercentage = 50;
        } else if (submission.status === 'pending') {
          // Just created but not submitted
          completionStatus = 'not_started';
          progressPercentage = 0;
        }

        if (contentProgress) {
          // Update existing entry
          const wasChanged = 
            contentProgress.completionStatus !== completionStatus ||
            contentProgress.progressPercentage !== progressPercentage ||
            (score !== null && contentProgress.score !== score);

          if (wasChanged) {
            contentProgress.completionStatus = completionStatus;
            contentProgress.progressPercentage = progressPercentage;
            contentProgress.lastAccessed = submission.submittedAt || new Date();
            contentProgress.attempts = submission.attemptNumber || 1;
            
            if (completedAt) {
              contentProgress.completedAt = completedAt;
            }
            if (score !== null) {
              contentProgress.score = score;
              contentProgress.bestScore = Math.max(contentProgress.bestScore || 0, score);
            }

            console.log(`  ✏️  Updated contentProgress for ${student.username} - ${submission.status} (${progressPercentage}%)`);
          } else {
            console.log(`  ✓  Already synced: ${student.username} - ${submission.status}`);
          }
        } else {
          // Create new entry
          const newProgress = {
            topicId: submission.topic,
            contentId: submission.contentId,
            contentType: 'submission',
            completionStatus: completionStatus,
            progressPercentage: progressPercentage,
            lastAccessed: submission.submittedAt || new Date(),
            attempts: submission.attemptNumber || 1,
            timeSpent: 0,
            watchCount: 0,
            bestScore: 0,
          };

          if (completedAt) {
            newProgress.completedAt = completedAt;
          }
          if (score !== null) {
            newProgress.score = score;
            newProgress.bestScore = score;
          }

          enrollment.contentProgress.push(newProgress);
          console.log(`  ➕  Created contentProgress for ${student.username} - ${submission.status} (${progressPercentage}%)`);
        }

        // Recalculate overall course progress using async version for accurate count
        const courseProgress = await student.calculateCourseProgressAsync(submission.course);
        const oldProgress = enrollment.progress;
        enrollment.progress = courseProgress;

        // Update course status if completed
        if (courseProgress === 100 && enrollment.status !== 'completed') {
          enrollment.status = 'completed';
          console.log(`  🎉  Course completed for ${student.username}!`);
        }

        student.markModified('enrolledCourses');
        await student.save();
        
        if (oldProgress !== courseProgress) {
          console.log(`  📈  Progress updated: ${oldProgress}% → ${courseProgress}%`);
        }

        syncedCount++;
      } catch (error) {
        console.error(`  ❌  Error processing submission ${submission._id}:`, error.message);
        errors.push({ submissionId: submission._id, error: error.message });
        errorCount++;
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('📊 SYNC SUMMARY');
    console.log('='.repeat(60));
    console.log(`✅ Successfully synced: ${syncedCount}`);
    console.log(`❌ Errors: ${errorCount}`);
    console.log(`📝 Total processed: ${submissions.length}`);
    
    if (errors.length > 0) {
      console.log('\n⚠️  Errors encountered:');
      errors.forEach((err, idx) => {
        console.log(`  ${idx + 1}. Submission ${err.submissionId}: ${err.error}`);
      });
    }

    console.log('\n✨ Sync completed!\n');

  } catch (error) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 Database connection closed');
    process.exit(0);
  }
}

// Run the script
syncSubmissionsToContentProgress();
