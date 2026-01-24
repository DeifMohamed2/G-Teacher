const mongoose = require('mongoose');

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
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
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
    bio: {
      type: String,
      trim: true,
      maxlength: 1000,
    },
    profilePicture: {
      type: String,
      trim: true,
      default: '',
    },

    // G-Teacher Platform Commission Percentage
    // This is the percentage that G-Teacher takes from each sale for this teacher
    gTeacherPercentage: {
      type: Number,
      min: 0,
      max: 100,
      default: 0,
    },

    // Status
    isActive: {
      type: Boolean,
      default: true,
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

// Generate unique teacher code before saving (TCH + 6 random digits)
TeacherSchema.pre('save', async function (next) {
  if (this.isNew && !this.teacherCode) {
    let teacherCode;
    let isUnique = false;
    let attempts = 0;

    while (!isUnique && attempts < 10) {
      // Generate code: TCH + 6 random digits
      const randomDigits = Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
      teacherCode = `TCH${randomDigits}`;

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

// Index for better query performance
TeacherSchema.index({ isActive: 1 });

module.exports = mongoose.model('Teacher', TeacherSchema);
