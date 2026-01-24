const Course = require('../models/Course');
const Teacher = require('../models/Teacher');
const User = require('../models/User');
const ExamPeriod = require('../models/ExamPeriod');

// Subject configuration with icons
const SUBJECT_CONFIG = {
  'Mathematics': { icon: 'fa-calculator', iconClass: 'math' },
  'Math': { icon: 'fa-calculator', iconClass: 'math' },
  'Math American': { icon: 'fa-square-root-alt', iconClass: 'math' },
  'Physics': { icon: 'fa-atom', iconClass: 'physics' },
  'Chemistry': { icon: 'fa-flask', iconClass: 'chemistry' },
  'Biology': { icon: 'fa-dna', iconClass: 'biology' },
  'English': { icon: 'fa-language', iconClass: 'english' },
  'ICT': { icon: 'fa-laptop-code', iconClass: 'ict' },
  'Computer Science': { icon: 'fa-code', iconClass: 'computer' },
  'Economics': { icon: 'fa-chart-line', iconClass: 'economics' },
  'Accounting': { icon: 'fa-file-invoice-dollar', iconClass: 'accounting' },
  'Sociology': { icon: 'fa-users', iconClass: 'sociology' },
  'Arabic': { icon: 'fa-language', iconClass: 'arabic' },
  'Business': { icon: 'fa-briefcase', iconClass: 'business' },
  'Geography': { icon: 'fa-globe-americas', iconClass: 'geography' },
  'Environmental': { icon: 'fa-leaf', iconClass: 'environmental' },
  'German': { icon: 'fa-language', iconClass: 'german' },
  'French': { icon: 'fa-language', iconClass: 'french' },
  'Checkpoint': { icon: 'fa-check-circle', iconClass: 'combined' },
  'Combined Science': { icon: 'fa-microscope', iconClass: 'combined' },
  'default': { icon: 'fa-book', iconClass: 'general' }
};

// Helper function to get subject icon config
const getSubjectConfig = (subject) => {
  return SUBJECT_CONFIG[subject] || SUBJECT_CONFIG['default'];
};

// Helper to get exam period icon
const getExamPeriodIcon = (displayName) => {
  if (!displayName) return 'fa-calendar';
  const lower = displayName.toLowerCase();
  if (lower.includes('jan')) return 'fa-snowflake';
  if (lower.includes('may') || lower.includes('jun')) return 'fa-sun';
  if (lower.includes('oct') || lower.includes('nov')) return 'fa-leaf';
  return 'fa-calendar';
};

// Get landing page data
const getLandingPage = async (req, res) => {
  try {
    const [stats, examPeriods, user] = await Promise.all([
      Promise.all([
        Course.countDocuments({ status: 'published', isActive: true }),
        Course.aggregate([
          { $match: { status: 'published', isActive: true } },
          { $project: { enrolledCount: { $size: '$enrolledStudents' } } },
          { $group: { _id: null, total: { $sum: '$enrolledCount' } } },
        ]),
        Teacher.countDocuments({ isActive: true }),
      ]).then(([totalCourses, enrollmentsResult, totalTeachers]) => ({
        totalCourses,
        totalStudents: enrollmentsResult[0]?.total || 0,
        totalTeachers,
      })),

      ExamPeriod.find({ isActive: true }).sort({ order: 1, startDate: 1 }).lean(),
      req.session.user ? User.findById(req.session.user.id) : null,
    ]);

    const formattedExamPeriods = examPeriods.map((period) => ({
      id: period._id,
      slug: period.name.toLowerCase().replace(/\s+/g, '-').replace(/\//g, '-'),
      name: period.name,
      displayName: period.displayName,
      year: period.year,
      icon: getExamPeriodIcon(period.displayName),
    }));

    res.render('index', {
      title: 'Home | G-Teacher Academy',
      theme: req.cookies.theme || 'light',
      user,
      cart: req.session.cart || [],
      examPeriods: formattedExamPeriods,
      stats: {
        totalCourses: stats.totalCourses,
        totalStudents: stats.totalStudents,
        totalTeachers: stats.totalTeachers,
      },
    });
  } catch (error) {
    console.error('Error fetching landing page data:', error);
    res.render('index', {
      title: 'Home | G-Teacher Academy',
      theme: req.cookies.theme || 'light',
      cart: req.session.cart || [],
      examPeriods: [],
      stats: {
        totalCourses: 0,
        totalStudents: 0,
        totalTeachers: 0,
      },
    });
  }
};

// API endpoint to get teachers by subject and exam period
const getTeachersBySubject = async (req, res) => {
  try {
    const { subject, examPeriodId } = req.query;

    if (!subject) {
      return res.status(400).json({ success: false, message: 'Subject is required' });
    }

    const courseQuery = { status: 'published', isActive: true };
    if (examPeriodId && examPeriodId !== 'all') {
      courseQuery.examPeriod = examPeriodId;
    }

    // Convert subject slug back to proper name for exact matching
    const subjectName = subject.replace(/-/g, ' ');
    
    const courses = await Course.find(courseQuery)
      .populate({
        path: 'teacher',
        match: { 
          subject: { $regex: new RegExp('^' + subjectName + '$', 'i') },
          isActive: true 
        },
        select: 'firstName lastName teacherCode profilePicture subject bio'
      })
      .populate('examPeriod', 'name displayName')
      .lean();

    const teacherMap = new Map();

    for (const course of courses) {
      if (!course.teacher) continue;

      const teacherId = course.teacher._id.toString();
      
      if (!teacherMap.has(teacherId)) {
        teacherMap.set(teacherId, {
          id: course.teacher._id,
          teacherCode: course.teacher.teacherCode,
          name: course.teacher.firstName + ' ' + course.teacher.lastName,
          image: course.teacher.profilePicture || '/images/place.png',
          subject: course.teacher.subject || subject,
          bio: course.teacher.bio || 'Expert educator',
          courses: 0,
          students: 0,
          rating: 4.8,
          minPrice: Infinity,
        });
      }

      const teacherData = teacherMap.get(teacherId);
      teacherData.courses++;
      teacherData.students += course.enrolledStudents?.length || 0;
      
      const finalPrice = course.discountPrice 
        ? course.price - (course.price * course.discountPrice / 100)
        : course.price;
      
      if (finalPrice && finalPrice < teacherData.minPrice) {
        teacherData.minPrice = finalPrice;
      }
    }

    const teachers = Array.from(teacherMap.values()).map(teacher => ({
      ...teacher,
      price: teacher.minPrice === Infinity ? 0 : Math.round(teacher.minPrice),
    }));

    res.json({ success: true, teachers, count: teachers.length });
  } catch (error) {
    console.error('Error fetching teachers by subject:', error);
    res.status(500).json({ success: false, message: 'Error fetching teachers' });
  }
};

// API endpoint to get subjects by exam period
const getSubjectsByExamPeriod = async (req, res) => {
  try {
    const { examPeriodId } = req.query;

    const courseQuery = { status: 'published', isActive: true };
    if (examPeriodId && examPeriodId !== 'all') {
      courseQuery.examPeriod = examPeriodId;
    }

    const courses = await Course.find(courseQuery).populate('teacher', 'subject').lean();

    const subjectsSet = new Set();
    courses.forEach(course => {
      if (course.teacher?.subject) {
        subjectsSet.add(course.teacher.subject);
      }
    });

    const subjects = Array.from(subjectsSet).map(subject => ({
      id: subject.toLowerCase().replace(/\s+/g, '-'),
      name: subject,
      ...getSubjectConfig(subject)
    }));

    res.json({ success: true, subjects });
  } catch (error) {
    console.error('Error fetching subjects:', error);
    res.status(500).json({ success: false, message: 'Error fetching subjects' });
  }
};

// Get Teacher Courses page
const getTeacherCourses = async (req, res) => {
  try {
    const { teacherId } = req.params;
    const { subject, examDate, courseType } = req.query;
    const mongoose = require('mongoose');
    
    const user = req.session.user ? await User.findById(req.session.user.id) : null;
    
    let teacher;
    
    if (mongoose.Types.ObjectId.isValid(teacherId)) {
      teacher = await Teacher.findById(teacherId);
    } else {
      teacher = await Teacher.findOne({ 
        $or: [
          { teacherCode: teacherId.toUpperCase() },
          { teacherCode: teacherId }
        ]
      });
    }
    
    if (!teacher) {
      req.flash('error_msg', 'Teacher not found');
      return res.redirect('/');
    }
    
    const filter = { teacher: teacher._id, status: 'published', isActive: true };
    if (courseType) filter.courseType = courseType;
    
    const courses = await Course.find(filter)
      .populate('topics')
      .populate('examPeriod', 'name displayName year')
      .sort({ createdAt: -1 })
      .lean();
    
    const uniqueStudents = new Set();
    courses.forEach(course => {
      if (course.enrolledStudents) {
        course.enrolledStudents.forEach(s => uniqueStudents.add(s.toString()));
      }
    });
    
    const teacherData = {
      _id: teacher._id,
      teacherCode: teacher.teacherCode,
      name: teacher.firstName + ' ' + teacher.lastName,
      image: teacher.profilePicture || '/images/place.png',
      specialty: teacher.subject ? teacher.subject + ' Expert' : 'IGCSE Expert',
      bio: teacher.bio || 'Dedicated to helping students achieve academic excellence.',
      qualification: 'Advanced Degree',
      language: 'English & Arabic',
      teachingStyle: 'Interactive & Engaging',
      totalCourses: courses.length,
      totalStudents: uniqueStudents.size,
      rating: 4.8
    };
    
    const formattedCourses = courses.map((course, index) => {
      const discountPercentage = course.discountPrice || 0;
      const originalPrice = course.price || 0;
      const finalPrice = discountPercentage > 0 
        ? originalPrice - (originalPrice * discountPercentage / 100)
        : originalPrice;
      
      return {
        id: course._id,
        title: course.title,
        shortDescription: course.shortDescription || course.description || 'Comprehensive course content',
        unit: teacher.subject || 'General',
        duration: '8-12 weeks',
        type: course.courseType || 'online',
        thumbnail: course.thumbnail || '/images/adad.png',
        originalPrice: Math.round(originalPrice),
        finalPrice: Math.round(finalPrice),
        discountPercentage: discountPercentage,
        lessonsCount: course.topics?.length || 0,
        studentsEnrolled: course.enrolledStudents?.length || 0,
        rating: 4.8,
        features: course.features?.length ? course.features : ['Video Lessons', 'Practice Problems', 'Live Support'],
        isBestseller: index === 0 && (course.enrolledStudents?.length || 0) > 10,
        isNew: (new Date() - new Date(course.createdAt)) < (30 * 24 * 60 * 60 * 1000),
        isFullyBooked: course.isFullyBooked || false,
        examPeriod: course.examPeriod?.displayName || ''
      };
    });
    
    res.render('teacher-courses', {
      title: teacherData.name + ' - Courses | G-Teacher Academy',
      theme: req.cookies.theme || 'light',
      teacher: teacherData,
      courses: formattedCourses,
      subject: teacher.subject || 'General',
      examDate: examDate || '',
      filterOptions: { subjects: [], courseTypes: ['online', 'recorded', 'onground'] },
      currentFilters: { subject, courseType },
      user,
      cart: req.session.cart || []
    });
  } catch (error) {
    console.error('Error fetching teacher courses:', error);
    res.status(500).render('404', {
      title: 'Page Not Found',
      theme: req.cookies.theme || 'light',
      user: req.session.user || null
    });
  }
};

const getIGTeacherCourses = getTeacherCourses;

module.exports = {
  getLandingPage,
  getTeacherCourses,
  getIGTeacherCourses,
  getTeachersBySubject,
  getSubjectsByExamPeriod,
};
