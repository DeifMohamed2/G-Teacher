const mongoose = require('mongoose');

const ExamPeriodSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      // e.g., "January 2026", "May/June 2026", "Oct/Nov 2026"
    },
    displayName: {
      type: String,
      required: true,
      trim: true,
      // e.g., "January", "May/June", "Oct/Nov"
    },
    curriculumType: {
      type: String,
      enum: ['IGCSE', 'American'],
      default: 'IGCSE',
      required: true,
      // Specifies whether this exam period is for IGCSE or American curriculum
    },
    year: {
      type: Number,
      required: true,
    },
    months: {
      type: [String],
      required: true,
      // e.g., ["January"], ["May", "June"], ["October", "November"]
    },
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      required: true,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: '',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    isCurrent: {
      type: Boolean,
      default: false,
      // Only one period can be current at a time
    },
    order: {
      type: Number,
      default: 0,
      // For sorting display order
    },
    // Statistics
    coursesCount: {
      type: Number,
      default: 0,
    },
    studentsCount: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
ExamPeriodSchema.index({ year: 1, startDate: 1 });
ExamPeriodSchema.index({ isActive: 1, isCurrent: 1 });
ExamPeriodSchema.index({ order: 1 });
ExamPeriodSchema.index({ curriculumType: 1 });
ExamPeriodSchema.index({ curriculumType: 1, isActive: 1, order: 1 });

// Virtual for formatted date range
ExamPeriodSchema.virtual('dateRange').get(function () {
  const options = { month: 'short', day: 'numeric', year: 'numeric' };
  const start = this.startDate.toLocaleDateString('en-US', options);
  const end = this.endDate.toLocaleDateString('en-US', options);
  return `${start} - ${end}`;
});

// Method to check if period is current (based on dates)
ExamPeriodSchema.methods.isCurrentPeriod = function () {
  const now = new Date();
  return now >= this.startDate && now <= this.endDate;
};

// Static method to get current period
ExamPeriodSchema.statics.getCurrentPeriod = async function () {
  const now = new Date();
  return await this.findOne({
    isActive: true,
    startDate: { $lte: now },
    endDate: { $gte: now },
  }).sort({ startDate: -1 });
};

// Static method to get upcoming periods
ExamPeriodSchema.statics.getUpcomingPeriods = async function (limit = 5) {
  const now = new Date();
  return await this.find({
    isActive: true,
    startDate: { $gt: now },
  })
    .sort({ startDate: 1 })
    .limit(limit);
};

// Static method to get active periods sorted by order
ExamPeriodSchema.statics.getActivePeriods = async function () {
  return await this.find({ isActive: true }).sort({ order: 1, startDate: 1 });
};

// Static method to get active periods by curriculum type
ExamPeriodSchema.statics.getActivePeriodsByCurriculum = async function (curriculumType) {
  const filter = { isActive: true };
  if (curriculumType) {
    filter.curriculumType = curriculumType;
  }
  return await this.find(filter).sort({ order: 1, startDate: 1 });
};

// Pre-save hook to ensure only one period is marked as current
ExamPeriodSchema.pre('save', async function (next) {
  if (this.isCurrent) {
    // Unset isCurrent for all other periods
    await this.constructor.updateMany(
      { _id: { $ne: this._id } },
      { $set: { isCurrent: false } }
    );
  }
  next();
});

// Pre-save hook to update coursesCount
ExamPeriodSchema.methods.updateCoursesCount = async function () {
  const Course = mongoose.model('Course');
  this.coursesCount = await Course.countDocuments({ examPeriod: this._id, isActive: true });
  await this.save();
};

const ExamPeriod = mongoose.model('ExamPeriod', ExamPeriodSchema);

module.exports = ExamPeriod;
