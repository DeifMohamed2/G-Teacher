const mongoose = require('mongoose');

const ContentItemSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['video', 'pdf', 'reading', 'link', 'zoom', 'submission'],
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    content: {
      type: String, // URL or file path
      required: function () {
        return this.type !== 'zoom' && this.type !== 'submission';
      },
    },

    // Zoom Meeting specific field
    zoomMeeting: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ZoomMeeting',
      required: function () {
        return this.type === 'zoom';
      },
    },

    // HW/Quiz Submission specific fields
    submissionConfig: {
      // The assignment file(s) that students will download
      assignmentFiles: [
        {
          fileName: {
            type: String,
            trim: true,
          },
          fileUrl: {
            type: String,
            trim: true,
          },
          fileType: {
            type: String,
            enum: ['pdf', 'image', 'document', 'other'],
            default: 'pdf',
          },
        },
      ],
      // Instructions for the submission
      instructions: {
        type: String,
        trim: true,
        maxlength: 5000,
      },
      // Due date for submission
      dueDate: {
        type: Date,
      },
      // Maximum score for grading
      maxScore: {
        type: Number,
        default: 100,
        min: 1,
      },
      // Allow late submissions
      allowLateSubmission: {
        type: Boolean,
        default: false,
      },
      // Late submission penalty (percentage deduction)
      latePenalty: {
        type: Number,
        default: 0,
        min: 0,
        max: 100,
      },
    },

    // General content fields
    duration: {
      type: Number, // in minutes
      default: 0,
    },
    isRequired: {
      type: Boolean,
      default: true,
    },
    order: {
      type: Number,
      default: 0,
    },
    // Video watch limit - how many times a student can complete watching the video
    maxWatchCount: {
      type: Number,
      default: null, // null means unlimited
      min: 1,
      validate: {
        validator: function (value) {
          // Only validate for video content
          return this.type !== 'video' || value === null || value >= 1;
        },
        message: 'Max watch count must be at least 1 for video content',
      },
    },
    prerequisites: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ContentItem',
      },
    ],
    dependencies: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ContentItem',
      },
    ],
    learningObjectives: [
      {
        type: String,
        trim: true,
      },
    ],
    tags: [
      {
        type: String,
        trim: true,
      },
    ],
    completionCriteria: {
      type: String,
      enum: ['view', 'complete', 'submit_assignment'],
      default: 'view',
    },
    unlockConditions: {
      type: String,
      enum: ['immediate', 'previous_completed'],
      default: 'immediate',
    },
  },
  { timestamps: true }
);

const TopicSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      minlength: 3,
      maxlength: 100,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: '',
    },
    course: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
      required: true,
    },
    order: {
      type: Number,
      required: true,
      default: 1,
    },
    content: [ContentItemSchema],
    estimatedTime: {
      type: Number, // in minutes
      default: 0,
    },
    isPublished: {
      type: Boolean,
      default: false,
    },
    difficulty: {
      type: String,
      enum: ['beginner', 'intermediate', 'advanced'],
      default: 'beginner',
    },
    learningObjectives: [
      {
        type: String,
        trim: true,
      },
    ],
    tags: [
      {
        type: String,
        trim: true,
      },
    ],
    unlockConditions: {
      type: String,
      enum: ['immediate', 'previous_completed'],
      default: 'immediate',
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      required: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Virtual for content count
TopicSchema.virtual('contentCount').get(function () {
  return this.content ? this.content.length : 0;
});

// Virtual for estimated duration
TopicSchema.virtual('totalDuration').get(function () {
  if (!this.content) return 0;
  return this.content.reduce((total, item) => total + (item.duration || 0), 0);
});

// Sort content by order before saving
TopicSchema.pre('save', function (next) {
  if (this.content && this.content.length > 0) {
    this.content.sort((a, b) => a.order - b.order);
  }
  next();
});

module.exports = mongoose.model('Topic', TopicSchema);
