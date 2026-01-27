const mongoose = require('mongoose');

const SubmissionSchema = new mongoose.Schema(
  {
    // Reference to the student who submitted
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Reference to the course
    course: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
      required: true,
    },
    // Reference to the topic
    topic: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Topic',
      required: true,
    },
    // Reference to the content item (the submission content)
    contentId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    // Student's submitted files
    submittedFiles: [
      {
        fileName: {
          type: String,
          required: true,
        },
        fileUrl: {
          type: String,
          required: true,
        },
        fileType: {
          type: String,
          enum: ['pdf', 'image', 'document', 'other'],
          default: 'other',
        },
        fileSize: {
          type: Number, // in bytes
          default: 0,
        },
        uploadedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    // Student's text answer (optional)
    textAnswer: {
      type: String,
      trim: true,
      maxlength: 10000,
    },
    // Submission status
    status: {
      type: String,
      enum: ['pending', 'submitted', 'graded', 'returned', 'late'],
      default: 'pending',
    },
    // Grading information
    grade: {
      score: {
        type: Number,
        min: 0,
        max: 100,
        default: null,
      },
      maxScore: {
        type: Number,
        default: 100,
      },
      letterGrade: {
        type: String,
        enum: ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F', null],
        default: null,
      },
      feedback: {
        type: String,
        trim: true,
        maxlength: 5000,
      },
      gradedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Admin',
      },
      gradedAt: {
        type: Date,
      },
    },
    // Submission timing
    submittedAt: {
      type: Date,
    },
    dueDate: {
      type: Date,
    },
    isLate: {
      type: Boolean,
      default: false,
    },
    // Attempt tracking
    attemptNumber: {
      type: Number,
      default: 1,
      min: 1,
    },
    // Teacher/Admin notes (internal, not visible to student)
    internalNotes: {
      type: String,
      trim: true,
      maxlength: 2000,
    },
    // Plagiarism check (optional feature)
    plagiarismCheck: {
      checked: {
        type: Boolean,
        default: false,
      },
      score: {
        type: Number,
        min: 0,
        max: 100,
      },
      checkedAt: {
        type: Date,
      },
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Compound indexes for efficient queries
SubmissionSchema.index({ student: 1, course: 1, topic: 1, contentId: 1 });
SubmissionSchema.index({ student: 1, status: 1 });
SubmissionSchema.index({ course: 1, status: 1 });
SubmissionSchema.index({ topic: 1, contentId: 1, status: 1 });
SubmissionSchema.index({ submittedAt: -1 });
SubmissionSchema.index({ 'grade.gradedAt': -1 });

// Virtual for checking if submission is graded
SubmissionSchema.virtual('isGraded').get(function () {
  return this.status === 'graded' && this.grade && this.grade.score !== null;
});

// Virtual for percentage score
SubmissionSchema.virtual('percentageScore').get(function () {
  if (this.grade && this.grade.score !== null && this.grade.maxScore) {
    return Math.round((this.grade.score / this.grade.maxScore) * 100);
  }
  return null;
});

// Virtual for time remaining until due date
SubmissionSchema.virtual('timeRemaining').get(function () {
  if (!this.dueDate) return null;
  const now = new Date();
  const diff = this.dueDate - now;
  if (diff <= 0) return 'Overdue';

  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

  if (days > 0) return `${days} day${days > 1 ? 's' : ''} left`;
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} left`;
  return 'Less than 1 hour left';
});

// Pre-save middleware to check if submission is late
SubmissionSchema.pre('save', function (next) {
  if (this.submittedAt && this.dueDate) {
    this.isLate = this.submittedAt > this.dueDate;
    if (this.isLate && this.status === 'submitted') {
      this.status = 'late';
    }
  }
  next();
});

// Post-save middleware to sync submission status with student's contentProgress
// Uses the User model's updateContentProgress method for atomic updates with retry logic
SubmissionSchema.post('save', async function (doc) {
  try {
    const User = mongoose.model('User');
    const student = await User.findById(doc.student);

    if (!student) {
      console.warn(`Student ${doc.student} not found for submission ${doc._id}`);
      return;
    }

    // Determine completion status and progress based on submission status
    let completionStatus = 'not_started';
    let progressPercentage = 0;
    let score = null;
    let completedAt = null;

    if (doc.status === 'graded' && doc.grade && doc.grade.score !== null) {
      // Graded - mark as completed with score
      completionStatus = 'completed';
      progressPercentage = 100;
      score = (doc.grade.score / doc.grade.maxScore) * 100;
      completedAt = doc.grade.gradedAt || new Date();
    } else if (['submitted', 'late'].includes(doc.status)) {
      // Submitted but not graded yet - mark as in_progress
      completionStatus = 'in_progress';
      progressPercentage = 50;
    } else if (doc.status === 'pending') {
      // Just created but not submitted
      completionStatus = 'not_started';
      progressPercentage = 0;
    }

    // Use the atomic updateContentProgress method with retry logic
    // This also recalculates overall course progress
    const progressData = {
      completionStatus,
      progressPercentage,
      lastAccessed: new Date(),
      attempts: doc.attemptNumber || 1,
    };

    if (completedAt) {
      progressData.completedAt = completedAt;
    }
    if (score !== null) {
      progressData.score = score;
      progressData.bestScore = score;
    }

    await student.updateContentProgress(
      doc.course,
      doc.topic,
      doc.contentId,
      'submission',
      progressData
    );

    console.log(`Auto-synced contentProgress for student ${doc.student}, submission ${doc._id}, status: ${doc.status}`);
  } catch (error) {
    console.error('Error in Submission post-save hook:', error);
    // Don't throw - we don't want to break the submission save
  }
});

// Static method to get student's submission for a specific content
SubmissionSchema.statics.getStudentSubmission = async function (studentId, courseId, topicId, contentId) {
  return await this.findOne({
    student: studentId,
    course: courseId,
    topic: topicId,
    contentId: contentId,
  }).sort({ attemptNumber: -1 });
};

// Static method to get all submissions for a content item
SubmissionSchema.statics.getContentSubmissions = async function (topicId, contentId) {
  return await this.find({
    topic: topicId,
    contentId: contentId,
  })
    .populate('student', 'firstName lastName username studentEmail studentCode')
    .sort({ submittedAt: -1 });
};

// Static method to get submission statistics for a content item
SubmissionSchema.statics.getContentStats = async function (topicId, contentId) {
  const stats = await this.aggregate([
    {
      $match: {
        topic: new mongoose.Types.ObjectId(topicId),
        contentId: new mongoose.Types.ObjectId(contentId),
      },
    },
    {
      $group: {
        _id: null,
        totalSubmissions: { $sum: 1 },
        gradedCount: {
          $sum: { $cond: [{ $eq: ['$status', 'graded'] }, 1, 0] },
        },
        pendingCount: {
          $sum: { $cond: [{ $in: ['$status', ['pending', 'submitted']] }, 1, 0] },
        },
        lateCount: {
          $sum: { $cond: [{ $eq: ['$isLate', true] }, 1, 0] },
        },
        averageScore: {
          $avg: {
            $cond: [
              { $eq: ['$status', 'graded'] },
              '$grade.score',
              null,
            ],
          },
        },
        highestScore: { $max: '$grade.score' },
        lowestScore: { $min: '$grade.score' },
      },
    },
  ]);

  return stats[0] || {
    totalSubmissions: 0,
    gradedCount: 0,
    pendingCount: 0,
    lateCount: 0,
    averageScore: 0,
    highestScore: 0,
    lowestScore: 0,
  };
};

// Instance method to calculate letter grade based on score
SubmissionSchema.methods.calculateLetterGrade = function () {
  if (this.grade && this.grade.score !== null) {
    const percentage = (this.grade.score / this.grade.maxScore) * 100;
    if (percentage >= 97) return 'A+';
    if (percentage >= 93) return 'A';
    if (percentage >= 90) return 'A-';
    if (percentage >= 87) return 'B+';
    if (percentage >= 83) return 'B';
    if (percentage >= 80) return 'B-';
    if (percentage >= 77) return 'C+';
    if (percentage >= 73) return 'C';
    if (percentage >= 70) return 'C-';
    if (percentage >= 67) return 'D+';
    if (percentage >= 63) return 'D';
    if (percentage >= 60) return 'D-';
    return 'F';
  }
  return null;
};

module.exports = mongoose.model('Submission', SubmissionSchema);
