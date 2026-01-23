const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const UserSchema = new mongoose.Schema(
  {
    // Personal Information (from registration form)
    firstName: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 50,
    },
    lastName: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 50,
    },
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      minlength: 3,
      maxlength: 30,
    },
    grade: {
      type: String,
      required: true,
      enum: [
        'Year 6',
        'Year 7',
        'Year 8',
        'Year 9',
        'Year 10',
        'Year 11',
        'Year 12',
        'Year 13',
      ],
    },
    curriculum: {
      type: String,
      required: true,
      enum: ['IGCSE', 'American'],
      trim: true,
    },

    // Contact Details (from registration form)
    studentEmail: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    studentNumber: {
      type: String,
      trim: true,
    },
    studentCountryCode: {
      type: String,
      trim: true,
      default: '+20',
    },
    parentNumber: {
      type: String,
      trim: true,
    },
    parentCountryCode: {
      type: String,
      trim: true,
      default: '+20',
    },
    howDidYouKnow: {
      type: String,
      trim: true,
      maxlength: 500,
    },

    // Account Setup
    password: {
      type: String,
      required: true,
      minlength: 4,
    },
    termsAccepted: {
      type: Boolean,
      default: false,
    },

    // System Generated
    studentCode: {
      type: String,
      unique: true,
    },
    role: {
      type: String,
      enum: ['student'],
      default: 'student',
      immutable: true,
    },
    isActive: {
      type: Boolean,
      default: false, // New users must be approved before access
    },
    profilePicture: {
      type: String,
      default: '',
    },

    // Multi-teacher course enrollments
    enrolledCourses: [
      {
        course: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Course',
        },
        teacher: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Teacher',
        },
        enrolledAt: {
          type: Date,
          default: Date.now,
        },
        progress: {
          type: Number,
          default: 0,
          min: 0,
          max: 100,
        },
        lastAccessed: {
          type: Date,
          default: Date.now,
        },
        completedTopics: [
          {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Topic',
          },
        ],
        status: {
          type: String,
          enum: ['active', 'completed', 'paused', 'dropped'],
          default: 'active',
        },
        // Content progress tracking
        contentProgress: [
          {
            topicId: {
              type: mongoose.Schema.Types.ObjectId,
              ref: 'Topic',
              required: true,
            },
            contentId: {
              type: mongoose.Schema.Types.ObjectId,
              required: true,
            },
            contentType: {
              type: String,
              enum: ['video', 'pdf', 'assignment', 'reading', 'link', 'zoom'],
              required: true,
            },
            completionStatus: {
              type: String,
              enum: ['not_started', 'in_progress', 'completed', 'failed'],
              default: 'not_started',
            },
            progressPercentage: {
              type: Number,
              default: 0,
              min: 0,
              max: 100,
            },
            lastAccessed: {
              type: Date,
              default: Date.now,
            },
            completedAt: Date,
            score: {
              type: Number,
              min: 0,
              max: 100,
            },
            timeSpent: {
              type: Number,
              default: 0,
            },
            attempts: {
              type: Number,
              default: 0,
            },
            lastPosition: {
              type: Number,
              default: 0,
            },
            watchCount: {
              type: Number,
              default: 0,
              min: 0,
            },
            bestScore: {
              type: Number,
              default: 0,
            },
          },
        ],
      },
    ],

    // Purchased courses
    purchasedCourses: [
      {
        course: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Course',
        },
        teacher: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Teacher',
        },
        purchasedAt: {
          type: Date,
          default: Date.now,
        },
        price: {
          type: Number,
          required: true,
        },
        orderNumber: {
          type: String,
          required: true,
        },
        status: {
          type: String,
          enum: ['active', 'expired', 'cancelled', 'refunded'],
          default: 'active',
        },
      },
    ],

    // Promo codes
    usedPromoCodes: [
      {
        promoCode: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'PromoCode',
        },
        usedAt: {
          type: Date,
          default: Date.now,
        },
        purchase: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Purchase',
        },
        discountAmount: Number,
        originalAmount: Number,
        finalAmount: Number,
      },
    ],

    // Wishlist (courses only, no bundles)
    wishlist: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
    }],

    // Preferences
    preferences: {
      theme: {
        type: String,
        enum: ['light', 'dark'],
        default: 'light',
      },
      notifications: {
        email: { type: Boolean, default: true },
        quizReminders: { type: Boolean, default: true },
        courseUpdates: { type: Boolean, default: true },
      },
      language: {
        type: String,
        default: 'en',
      },
    },

    // Session management
    sessionToken: {
      type: String,
      default: null,
      index: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Hash password before save
UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Pre-save middleware to prevent duplicate enrollments
UserSchema.pre('save', async function (next) {
  if (this.isModified('enrolledCourses')) {
    const seenCourses = new Set();
    this.enrolledCourses = this.enrolledCourses.filter((enrollment) => {
      if (!enrollment.course) return false;
      const courseId = enrollment.course.toString();
      if (seenCourses.has(courseId)) {
        return false;
      }
      seenCourses.add(courseId);
      return true;
    });
  }
  next();
});

// Generate unique student code before saving
UserSchema.pre('save', async function (next) {
  if (this.isNew && !this.studentCode) {
    let studentCode;
    let isUnique = false;
    let attempts = 0;

    while (!isUnique && attempts < 10) {
      studentCode = 'STU' + Math.floor(Math.random() * 10000).toString().padStart(4, '0');
      const existingUser = await this.constructor.findOne({ studentCode });
      if (!existingUser) {
        isUnique = true;
      }
      attempts++;
    }

    this.studentCode = studentCode;
  }
  next();
});

// Compare password
UserSchema.methods.matchPassword = async function (enteredPassword) {
  return bcrypt.compare(enteredPassword, this.password);
};

// Virtual for full name
UserSchema.virtual('name').get(function () {
  return `${this.firstName} ${this.lastName}`;
});

// Virtual for total enrolled courses
UserSchema.virtual('totalEnrolledCourses').get(function () {
  return this.enrolledCourses ? this.enrolledCourses.length : 0;
});

// Virtual for completed courses
UserSchema.virtual('completedCourses').get(function () {
  if (!this.enrolledCourses) return 0;
  return this.enrolledCourses.filter((course) => course.status === 'completed').length;
});

// Virtual to get unique teachers the student is learning from
UserSchema.virtual('teachers').get(function () {
  if (!this.enrolledCourses) return [];
  const teacherIds = new Set();
  this.enrolledCourses.forEach((enrollment) => {
    if (enrollment.teacher) {
      teacherIds.add(enrollment.teacher.toString());
    }
  });
  return Array.from(teacherIds);
});

// Instance method to get course progress
UserSchema.methods.getCourseProgress = function (courseId) {
  const enrollment = this.enrolledCourses.find(
    (e) => e.course && e.course.toString() === courseId.toString()
  );
  return enrollment ? enrollment.progress : 0;
};

// Instance method to update course progress
UserSchema.methods.updateCourseProgress = async function (courseId, progress, topicId = null) {
  const enrollment = this.enrolledCourses.find(
    (e) => e.course && e.course.toString() === courseId.toString()
  );

  if (enrollment) {
    enrollment.progress = Math.min(Math.max(progress, 0), 100);
    enrollment.lastAccessed = new Date();

    if (topicId && !enrollment.completedTopics.includes(topicId)) {
      enrollment.completedTopics.push(topicId);
    }

    if (enrollment.progress === 100) {
      enrollment.status = 'completed';
    }

    return await this.save();
  }

  return null;
};

// Instance method to enroll in a course
UserSchema.methods.enrollInCourse = async function (courseId, teacherId) {
  const existingEnrollment = this.enrolledCourses.find(
    (e) => e.course && e.course.toString() === courseId.toString()
  );

  if (existingEnrollment) {
    return { success: false, message: 'Already enrolled in this course' };
  }

  this.enrolledCourses.push({
    course: courseId,
    teacher: teacherId,
    enrolledAt: new Date(),
    progress: 0,
    status: 'active',
    completedTopics: [],
    contentProgress: [],
  });

  await this.save();
  return { success: true, message: 'Successfully enrolled' };
};

// Instance method to get courses by a specific teacher
UserSchema.methods.getCoursesByTeacher = function (teacherId) {
  return this.enrolledCourses.filter(
    (e) => e.teacher && e.teacher.toString() === teacherId.toString()
  );
};

// Instance method to add course to wishlist
UserSchema.methods.addToWishlist = async function (courseId) {
  if (!this.wishlist.includes(courseId)) {
    this.wishlist.push(courseId);
    await this.save();
    return { success: true, message: 'Added to wishlist' };
  }
  return { success: false, message: 'Already in wishlist' };
};

// Instance method to remove from wishlist
UserSchema.methods.removeFromWishlist = async function (courseId) {
  this.wishlist = this.wishlist.filter((id) => id.toString() !== courseId.toString());
  await this.save();
  return { success: true, message: 'Removed from wishlist' };
};

// Check if user is enrolled in a course
UserSchema.methods.isEnrolled = function (courseId) {
  if (!courseId) return false;
  return this.enrolledCourses.some(
    (e) => e.course && e.course.toString() === courseId.toString()
  );
};

// Check if user has access to a course
UserSchema.methods.hasAccessToCourse = function (courseId) {
  return this.isEnrolled(courseId);
};

// Add a purchased course
UserSchema.methods.addPurchasedCourse = async function (courseId, price, orderNumber, teacherId = null) {
  const existingPurchase = this.purchasedCourses.find(
    (p) => p.course && p.course.toString() === courseId.toString()
  );
  
  if (!existingPurchase) {
    this.purchasedCourses.push({
      course: courseId,
      teacher: teacherId,
      purchasedAt: new Date(),
      price,
      orderNumber,
      status: 'active',
    });
  }
  
  return await this.save();
};

// Enroll in course by ID
UserSchema.methods.enrollInCourseById = async function (courseId, teacherId = null) {
  return this.enrollInCourse(courseId, teacherId);
};

// Get user's purchased courses grouped by teacher
UserSchema.methods.getPurchasedByTeacher = function () {
  const teacherMap = new Map();
  
  for (const purchase of this.purchasedCourses) {
    const teacherId = purchase.teacher ? purchase.teacher.toString() : 'no-teacher';
    if (!teacherMap.has(teacherId)) {
      teacherMap.set(teacherId, {
        teacher: purchase.teacher,
        courses: [],
        totalPrice: 0,
      });
    }
    teacherMap.get(teacherId).courses.push(purchase);
    teacherMap.get(teacherId).totalPrice += purchase.price || 0;
  }
  
  return Array.from(teacherMap.values());
};

// Check if course is purchased
UserSchema.methods.hasPurchasedCourse = function (courseId) {
  if (!courseId) return false;
  return this.purchasedCourses.some(
    (p) => p.course && p.course.toString() === courseId.toString()
  );
};

// Alias for backwards compatibility with views using bundle terminology
UserSchema.methods.hasPurchasedBundle = function (courseId) {
  return this.hasPurchasedCourse(courseId);
};

// Check if course is in wishlist
UserSchema.methods.isCourseInWishlist = function (courseId) {
  if (!courseId || !this.wishlist) return false;
  return this.wishlist.some((id) => id.toString() === courseId.toString());
};

// Alias for backwards compatibility with views using bundle terminology
UserSchema.methods.isBundleInWishlist = function (courseId) {
  return this.isCourseInWishlist(courseId);
};

// Indexes for better query performance (excluding fields with unique: true which auto-create indexes)
UserSchema.index({ isActive: 1 });
UserSchema.index({ 'enrolledCourses.course': 1 });
UserSchema.index({ 'enrolledCourses.teacher': 1 });

module.exports = mongoose.model('User', UserSchema);
