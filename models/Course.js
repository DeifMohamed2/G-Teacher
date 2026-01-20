const mongoose = require('mongoose');

const CourseSchema = new mongoose.Schema(
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
      maxlength: 1000,
      default: '',
    },
    shortDescription: {
      type: String,
      trim: true,
      maxlength: 200,
      default: '',
    },
    courseCode: {
      type: String,
      unique: true,
      trim: true,
      uppercase: true,
    },

    // Course belongs to a Teacher
    teacher: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Teacher',
      required: false,
    },

    // Course classification
    subject: {
      type: String,
      required: false, // Made optional for backward compatibility
      trim: true,
      maxlength: 100,
    },
    level: {
      type: String,
      enum: ['Beginner', 'Intermediate', 'Advanced'],
      required: false, // Made optional for backward compatibility
    },
    category: {
      type: String,
      enum: ['online', 'onground', 'recorded', 'recovery'],
      default: 'online',
    },
    year: {
      type: String,
      trim: true,
      default: '',
    },
    testType: {
      type: String,
      enum: ['EST', 'SAT', 'ACT', 'EST&SAT', 'General'],
      default: 'General',
    },

    // Course details
    duration: {
      type: Number, // in hours
      required: false, // Made optional for backward compatibility
      min: 0,
      default: 0,
    },
    price: {
      type: Number,
      required: false, // Made optional for backward compatibility
      min: 0,
      default: 0,
    },
    discountPrice: {
      type: Number,
      min: 0,
      max: 100,
      default: 0,
    },
    thumbnail: {
      type: String,
      default: '',
    },

    // Status
    status: {
      type: String,
      enum: ['draft', 'published', 'archived'],
      default: 'draft',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    isFullyBooked: {
      type: Boolean,
      default: false,
    },
    fullyBookedMessage: {
      type: String,
      trim: true,
      maxlength: 100,
      default: 'FULLY BOOKED',
    },
    maxStudents: {
      type: Number,
      min: 0,
      default: 0, // 0 means unlimited
    },

    // Course content
    topics: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Topic',
      },
    ],

    // Enrolled students
    enrolledStudents: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],

    // Course metadata
    tags: [
      {
        type: String,
        trim: true,
      },
    ],
    prerequisites: [
      {
        type: String,
        trim: true,
      },
    ],
    features: [
      {
        type: String,
        trim: true,
      },
    ],

    // Book fields
    hasBook: {
      type: Boolean,
      default: false,
    },
    bookName: {
      type: String,
      trim: true,
      maxlength: 200,
      default: '',
    },
    bookPrice: {
      type: Number,
      min: 0,
      default: 0,
    },

    // Sequential ordering
    order: {
      type: Number,
      default: 0,
      min: 0,
    },
    requiresSequential: {
      type: Boolean,
      default: false,
    },
    prerequisiteCourses: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Course',
      },
    ],
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Virtual for topic count
CourseSchema.virtual('topicCount').get(function () {
  return this.topics ? this.topics.length : 0;
});

// Virtual for enrolled student count
CourseSchema.virtual('enrolledCount').get(function () {
  return this.enrolledStudents ? this.enrolledStudents.length : 0;
});

// Virtual for savings calculation
CourseSchema.virtual('savings').get(function () {
  if (this.discountPrice && this.price) {
    return this.price * (this.discountPrice / 100);
  }
  return 0;
});

// Virtual for final price after discount
CourseSchema.virtual('finalPrice').get(function () {
  if (this.discountPrice && this.price) {
    return this.price - this.price * (this.discountPrice / 100);
  }
  return this.price;
});

// Virtual for savings percentage
CourseSchema.virtual('savingsPercentage').get(function () {
  if (this.discountPrice) {
    return this.discountPrice;
  }
  return 0;
});

// Virtual to check if course is available for enrollment
CourseSchema.virtual('isAvailable').get(function () {
  if (!this.isActive || this.status !== 'published') {
    return false;
  }
  if (this.isFullyBooked) {
    return false;
  }
  if (this.maxStudents > 0 && this.enrolledStudents.length >= this.maxStudents) {
    return false;
  }
  return true;
});

// Generate course code before saving
CourseSchema.pre('save', async function (next) {
  if (this.isNew && !this.courseCode) {
    let courseCode;
    let isUnique = false;
    let attempts = 0;

    while (!isUnique && attempts < 10) {
      const titlePrefix = this.title.replace(/[^a-zA-Z0-9]/g, '').substring(0, 3).toUpperCase();
      const prefix = titlePrefix.length >= 2 ? titlePrefix : 'CRS';
      
      const timestamp = Date.now().toString().slice(-6);
      const randomNum = Math.floor(Math.random() * 100).toString().padStart(2, '0');
      courseCode = `${prefix}${timestamp}${randomNum}`;

      const existingCourse = await mongoose.model('Course').findOne({ courseCode });
      if (!existingCourse) {
        isUnique = true;
      }
      attempts++;
    }

    this.courseCode = courseCode;
  }
  next();
});

// Static method to check if a course is unlocked for a student
CourseSchema.statics.isCourseUnlocked = async function (studentId, courseId) {
  const Course = mongoose.model('Course');
  const User = mongoose.model('User');

  try {
    const course = await Course.findById(courseId);
    if (!course) {
      return { unlocked: false, reason: 'Course not found' };
    }

    // If no sequential requirement, course is always unlocked
    if (!course.requiresSequential) {
      return { unlocked: true, reason: 'No sequential requirement' };
    }

    // If no prerequisite courses defined, course is unlocked
    if (!course.prerequisiteCourses || course.prerequisiteCourses.length === 0) {
      return { unlocked: true, reason: 'No prerequisites' };
    }

    const student = await User.findById(studentId);
    if (!student) {
      return { unlocked: false, reason: 'Student not found' };
    }

    // Check all prerequisite courses are completed
    for (const prereqId of course.prerequisiteCourses) {
      const enrollment = student.enrolledCourses.find(
        (e) => e.course && e.course.toString() === prereqId.toString()
      );

      if (!enrollment || enrollment.status !== 'completed') {
        const prereqCourse = await Course.findById(prereqId);
        return {
          unlocked: false,
          reason: `Complete "${prereqCourse?.title || 'prerequisite course'}" first`,
          prerequisiteCourse: {
            id: prereqId,
            title: prereqCourse?.title,
          },
        };
      }
    }

    return { unlocked: true, reason: 'All prerequisites completed' };
  } catch (error) {
    console.error('Error checking course unlock status:', error);
    return { unlocked: false, reason: 'Error checking unlock status' };
  }
};

// Instance method to get unlock status for a student
CourseSchema.methods.getUnlockStatus = async function (studentId) {
  const Course = mongoose.model('Course');
  return await Course.isCourseUnlocked(studentId, this._id);
};

// Static method to get all courses by a teacher with unlock status for a student
CourseSchema.statics.getTeacherCoursesWithStatus = async function (teacherId, studentId) {
  const Course = mongoose.model('Course');
  const courses = await Course.find({ teacher: teacherId })
    .sort({ order: 1 })
    .populate('topics')
    .populate('teacher', 'firstName lastName teacherCode');

  const coursesWithStatus = await Promise.all(
    courses.map(async (course) => {
      const unlockStatus = await course.getUnlockStatus(studentId);
      return {
        ...course.toObject(),
        isUnlocked: unlockStatus.unlocked,
        unlockReason: unlockStatus.reason,
        prerequisiteCourse: unlockStatus.prerequisiteCourse,
      };
    })
  );

  return coursesWithStatus;
};

// Static method to enroll a student in a course
CourseSchema.statics.enrollStudent = async function (courseId, studentId) {
  const Course = mongoose.model('Course');
  const User = mongoose.model('User');

  const course = await Course.findById(courseId);
  if (!course) {
    return { success: false, message: 'Course not found' };
  }

  if (!course.isAvailable) {
    return { success: false, message: course.isFullyBooked ? course.fullyBookedMessage : 'Course is not available' };
  }

  // Check if already enrolled
  if (course.enrolledStudents.includes(studentId)) {
    return { success: false, message: 'Already enrolled in this course' };
  }

  // Add student to course
  course.enrolledStudents.push(studentId);
  await course.save();

  // Add course to student's enrollments
  const student = await User.findById(studentId);
  if (student) {
    await student.enrollInCourse(courseId, course.teacher);
  }

  return { success: true, message: 'Successfully enrolled' };
};

// Indexes for better query performance (excluding courseCode which has unique: true)
CourseSchema.index({ teacher: 1 });
CourseSchema.index({ status: 1, isActive: 1 });
CourseSchema.index({ courseType: 1 });
CourseSchema.index({ testType: 1 });
CourseSchema.index({ subject: 1 });
CourseSchema.index({ teacher: 1, status: 1, isActive: 1 });

module.exports = mongoose.model('Course', CourseSchema);
