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

    // Course belongs to an Exam Period
    examPeriod: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ExamPeriod',
      required: false,
    },

    // Course classification
    year: {
      type: String,
      trim: true,
      default: '',
    },

    // Course details
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

// Static method to get all courses by a teacher with unlock status for a student
CourseSchema.statics.getTeacherCoursesWithStatus = async function (teacherId, studentId) {
  const Course = mongoose.model('Course');
  const courses = await Course.find({ teacher: teacherId })
    .sort({ createdAt: -1 })
    .populate('topics')
    .populate('teacher', 'firstName lastName teacherCode');

  const coursesWithStatus = await Promise.all(
    courses.map(async (course) => {
      return {
        ...course.toObject(),
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
CourseSchema.index({ examPeriod: 1 });
CourseSchema.index({ status: 1, isActive: 1 });
CourseSchema.index({ teacher: 1, status: 1, isActive: 1 });
CourseSchema.index({ examPeriod: 1, isActive: 1 });

module.exports = mongoose.model('Course', CourseSchema);
