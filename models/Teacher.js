const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const TeacherSchema = new mongoose.Schema(
  {
    // Basic Information
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
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    password: {
      type: String,
      required: true,
      minlength: 6,
    },
    phoneNumber: {
      type: String,
      trim: true,
    },
    countryCode: {
      type: String,
      trim: true,
      default: '+20',
    },

    // Teacher-specific fields
    teacherCode: {
      type: String,
      unique: true,
      trim: true,
      uppercase: true,
    },
    subject: {
      type: String,
      trim: true,
      maxlength: 100,
    },
    specialization: [{
      type: String,
      trim: true,
    }],
    bio: {
      type: String,
      trim: true,
      maxlength: 1000,
    },
    qualifications: [{
      type: String,
      trim: true,
    }],
    profilePicture: {
      type: String,
      default: '',
    },

    // Teacher settings
    settings: {
      allowEnrollment: {
        type: Boolean,
        default: true,
      },
      showContactInfo: {
        type: Boolean,
        default: false,
      },
      maxStudentsPerCourse: {
        type: Number,
        default: 100,
        min: 1,
      },
    },

    // Social links
    socialLinks: {
      website: { type: String, trim: true },
      facebook: { type: String, trim: true },
      instagram: { type: String, trim: true },
      twitter: { type: String, trim: true },
      youtube: { type: String, trim: true },
      linkedin: { type: String, trim: true },
      tiktok: { type: String, trim: true },
    },

    // Status
    role: {
      type: String,
      enum: ['teacher', 'admin', 'superAdmin'],
      default: 'teacher',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    isVerified: {
      type: Boolean,
      default: false,
    },

    // Session management
    sessionToken: {
      type: String,
      default: null,
      index: true,
    },

    // Preferences
    preferences: {
      theme: {
        type: String,
        enum: ['light', 'dark'],
        default: 'light',
      },
      notifications: {
        email: { type: Boolean, default: true },
        newEnrollment: { type: Boolean, default: true },
        courseUpdates: { type: Boolean, default: true },
      },
      language: {
        type: String,
        default: 'en',
      },
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Virtual for full name
TeacherSchema.virtual('name').get(function () {
  return `${this.firstName} ${this.lastName}`;
});

// Virtual to get all courses belonging to this teacher
TeacherSchema.virtual('courses', {
  ref: 'Course',
  localField: '_id',
  foreignField: 'teacher',
});

// Virtual for total students count
TeacherSchema.virtual('totalStudents').get(async function () {
  const Course = mongoose.model('Course');
  const courses = await Course.find({ teacher: this._id });
  const studentIds = new Set();
  courses.forEach(course => {
    if (course.enrolledStudents) {
      course.enrolledStudents.forEach(id => studentIds.add(id.toString()));
    }
  });
  return studentIds.size;
});

// Hash password before save
TeacherSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Generate unique teacher code before saving
TeacherSchema.pre('save', async function (next) {
  if (this.isNew && !this.teacherCode) {
    let teacherCode;
    let isUnique = false;
    let attempts = 0;

    while (!isUnique && attempts < 10) {
      // Generate code: TCH + first 2 letters of name + random 4 digits
      const namePrefix = this.firstName.replace(/[^a-zA-Z]/g, '').substring(0, 2).toUpperCase();
      const randomNum = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
      teacherCode = `TCH${namePrefix}${randomNum}`;

      const existingTeacher = await this.constructor.findOne({ teacherCode });
      if (!existingTeacher) {
        isUnique = true;
      }
      attempts++;
    }

    this.teacherCode = teacherCode;
  }
  next();
});

// Compare password
TeacherSchema.methods.matchPassword = async function (enteredPassword) {
  return bcrypt.compare(enteredPassword, this.password);
};

// Instance method to get all courses
TeacherSchema.methods.getCourses = async function () {
  const Course = mongoose.model('Course');
  return await Course.find({ teacher: this._id }).populate('topics');
};

// Instance method to get all enrolled students across all courses
TeacherSchema.methods.getStudents = async function () {
  const Course = mongoose.model('Course');
  const User = mongoose.model('User');
  
  const courses = await Course.find({ teacher: this._id });
  const studentIds = new Set();
  
  courses.forEach(course => {
    if (course.enrolledStudents) {
      course.enrolledStudents.forEach(id => studentIds.add(id.toString()));
    }
  });
  
  return await User.find({ _id: { $in: Array.from(studentIds) } });
};

// Instance method to get course statistics
TeacherSchema.methods.getStatistics = async function () {
  const Course = mongoose.model('Course');
  const courses = await Course.find({ teacher: this._id });
  
  const studentIds = new Set();
  let totalEnrollments = 0;
  
  courses.forEach(course => {
    if (course.enrolledStudents) {
      totalEnrollments += course.enrolledStudents.length;
      course.enrolledStudents.forEach(id => studentIds.add(id.toString()));
    }
  });
  
  return {
    totalCourses: courses.length,
    activeCourses: courses.filter(c => c.isActive && c.status === 'published').length,
    totalUniqueStudents: studentIds.size,
    totalEnrollments: totalEnrollments,
  };
};

// Indexes for better query performance (excluding fields with unique: true which auto-create indexes)
TeacherSchema.index({ isActive: 1, isVerified: 1 });

module.exports = mongoose.model('Teacher', TeacherSchema);
