const Course = require('../models/Course');
const Teacher = require('../models/Teacher');
const User = require('../models/User');
const BrilliantStudent = require('../models/BrilliantStudent');
const TeamMember = require('../models/TeamMember');

// Get landing page data
const getLandingPage = async (req, res) => {
  try {
    // Execute all database queries in parallel for better performance
    const [
      onlineCourses,
      ongroundCourses,
      recordedCourses,
      recoveryCourses,
      stats,
      brilliantStudents,
      teamMembers,
      user
    ] = await Promise.all([
      // Get featured courses with minimal data
      Course.find({
        courseType: 'online',
        status: 'published',
        isActive: true,
      })
        .populate('teacher', 'firstName lastName teacherCode profilePicture')
        .select('title shortDescription price thumbnail courseType createdAt teacher')
        .sort({ createdAt: -1 })
        .limit(6)
        .lean(),

      Course.find({
        courseType: 'onground',
        status: 'published',
        isActive: true,
      })
        .populate('teacher', 'firstName lastName teacherCode profilePicture')
        .select('title shortDescription price thumbnail courseType createdAt teacher')
        .sort({ createdAt: -1 })
        .limit(6)
        .lean(),

      Course.find({
        courseType: 'recorded',
        status: 'published',
        isActive: true,
      })
        .populate('teacher', 'firstName lastName teacherCode profilePicture')
        .select('title shortDescription price thumbnail courseType createdAt teacher')
        .sort({ createdAt: -1 })
        .limit(6)
        .lean(),

      Course.find({
        courseType: 'recovery',
        status: 'published',
        isActive: true,
      })
        .populate('teacher', 'firstName lastName teacherCode profilePicture')
        .select('title shortDescription price thumbnail courseType createdAt teacher')
        .sort({ createdAt: -1 })
        .limit(6)
        .lean(),

      // Get stats in parallel
      Promise.all([
        Course.countDocuments({
          courseType: 'online',
          status: 'published',
          isActive: true,
        }),
        Course.countDocuments({
          courseType: 'onground',
          status: 'published',
          isActive: true,
        }),
        Course.countDocuments({
          courseType: 'recorded',
          status: 'published',
          isActive: true,
        }),
        Course.countDocuments({
          courseType: 'recovery',
          status: 'published',
          isActive: true,
        }),
        Course.aggregate([
          { $match: { status: 'published', isActive: true } },
          { $project: { enrolledCount: { $size: '$enrolledStudents' } } },
          { $group: { _id: null, total: { $sum: '$enrolledCount' } } },
        ])
      ]).then(([onlineCourses, ongroundCourses, recordedCourses, recoveryCourses, totalStudents]) => ({
        onlineCourses,
        ongroundCourses,
        recordedCourses,
        recoveryCourses,
        totalStudents: totalStudents[0]?.total || 0,
      })),

      // Get brilliant students for each test type in parallel (load all active students)
      Promise.all([
        BrilliantStudent.getByTestType('EST'),
        BrilliantStudent.getByTestType('DSAT'),
        BrilliantStudent.getByTestType('ACT'),
      ]).then(([est, dsat, act]) => ({ est, dsat, act })),

      // Get team members
      TeamMember.getActiveMembers(),

      // Get user data if logged in (minimal data)
      req.session.user ? User.findById(req.session.user.id) : null
    ]);

    res.render('index', {
      title: 'Home | ELKABLY',
      theme: req.cookies.theme || 'light',
      // Pass as courses (with bundles aliases for backwards compatibility)
      onlineCourses,
      ongroundCourses,
      recordedCourses,
      recoveryCourses,
      onlineBundles: onlineCourses,
      ongroundBundles: ongroundCourses,
      recordedBundles: recordedCourses,
      recoveryBundles: recoveryCourses,
      user,
      cart: req.session.cart || [],
      brilliantStudents,
      teamMembers,
      stats: {
        onlineCourses: stats.onlineCourses,
        ongroundCourses: stats.ongroundCourses,
        recordedCourses: stats.recordedCourses,
        recoveryCourses: stats.recoveryCourses,
        onlineBundles: stats.onlineCourses,
        ongroundBundles: stats.ongroundCourses,
        recordedBundles: stats.recordedCourses,
        recoveryBundles: stats.recoveryCourses,
        totalStudents: stats.totalStudents,
      },
    });
  } catch (error) {
    console.error('Error fetching landing page data:', error);
    res.render('index', {
      title: 'Home | ELKABLY',
      theme: req.cookies.theme || 'light',
      onlineCourses: [],
      ongroundCourses: [],
      recordedCourses: [],
      recoveryCourses: [],
      onlineBundles: [],
      ongroundBundles: [],
      recordedBundles: [],
      recoveryBundles: [],
      featuredGameRooms: [],
      cart: req.session.cart || [],
      testCounts: { EST: 0, SAT: 0, ACT: 0 },
      brilliantStudents: {
        est: [],
        dsat: [],
        act: [],
      },
      teamMembers: [],
      stats: {
        onlineCourses: 0,
        ongroundCourses: 0,
        recordedCourses: 0,
        recoveryCourses: 0,
        onlineBundles: 0,
        ongroundBundles: 0,
        recordedBundles: 0,
        recoveryBundles: 0,
        totalQuizzes: 0,
        totalGameRooms: 0,
        totalStudents: 0,
      },
    });
  }
};

// Helper function to get courses by type
const getCoursesByType = async (req, res, courseType, viewName, pageTitle) => {
  try {
    const { page = 1, limit = 12, search, subject, testType, teacher } = req.query;

    const filter = {
      courseType,
      status: 'published',
      isActive: true,
    };

    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { shortDescription: { $regex: search, $options: 'i' } },
      ];
    }
    if (subject) filter.subject = subject;
    if (testType) filter.testType = testType;
    if (teacher) filter.teacher = teacher;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const courses = await Course.find(filter)
      .populate('teacher', 'firstName lastName teacherCode profilePicture')
      .populate('topics')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const totalCourses = await Course.countDocuments(filter);
    const totalPages = Math.ceil(totalCourses / parseInt(limit));

    // Get filter options
    const subjects = await Course.distinct('subject', {
      courseType,
      status: 'published',
      isActive: true,
    });
    const testTypes = await Course.distinct('testType', {
      courseType,
      status: 'published',
      isActive: true,
    });
    const teachers = await Teacher.find({ isActive: true })
      .select('firstName lastName teacherCode')
      .lean();

    // Get user if logged in
    let user = null;
    if (req.session.user) {
      user = await User.findById(req.session.user.id);
    }

    res.render(viewName, {
      title: `${pageTitle} | ELKABLY`,
      theme: req.cookies.theme || 'light',
      // For backwards compatibility
      bundles: courses,
      courses,
      user,
      cart: req.session.cart || [],
      filterOptions: { subjects, testTypes, teachers },
      currentFilters: { search, subject, testType, teacher },
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalBundles: totalCourses,
        totalCourses,
        hasNext: parseInt(page) < totalPages,
        hasPrev: parseInt(page) > 1,
      },
    });
  } catch (error) {
    console.error(`Error fetching ${courseType} courses:`, error);
    req.flash('error_msg', `Error loading ${courseType} courses`);
    res.render(viewName, {
      title: `${pageTitle} | ELKABLY`,
      theme: req.cookies.theme || 'light',
      bundles: [],
      courses: [],
      cart: req.session.cart || [],
      filterOptions: { subjects: [], testTypes: [], teachers: [] },
      currentFilters: {},
      pagination: {
        currentPage: 1,
        totalPages: 0,
        totalBundles: 0,
        totalCourses: 0,
        hasNext: false,
        hasPrev: false,
      },
    });
  }
};

// Get online courses page
const getOnlineCourses = async (req, res) => {
  return getCoursesByType(req, res, 'online', 'online-courses', 'Online Courses');
};

// Get onground courses page
const getOngroundCourses = async (req, res) => {
  return getCoursesByType(req, res, 'onground', 'onground-courses', 'On-Ground Courses');
};

// Get recorded courses page
const getRecordedCourses = async (req, res) => {
  return getCoursesByType(req, res, 'recorded', 'recorded-courses', 'Recorded Courses');
};

// Get recovery courses page
const getRecoveryCourses = async (req, res) => {
  return getCoursesByType(req, res, 'recovery', 'recovery-courses', 'Recovery Courses');
};

// Get course content (replaces getBundleContent)
const getCourseContent = async (req, res) => {
  try {
    const { id } = req.params;

    // Validate ID format
    if (!id || !require('mongoose').Types.ObjectId.isValid(id)) {
      req.flash('error_msg', 'Invalid course ID');
      return res.redirect('/courses');
    }

    const course = await Course.findById(id)
      .populate('teacher', 'firstName lastName teacherCode profilePicture bio')
      .populate('topics')
      .populate('enrolledStudents', 'username studentEmail');

    if (!course) {
      req.flash('error_msg', 'Course not found');
      return res.redirect('/courses');
    }

    if (course.status !== 'published' || !course.isActive) {
      req.flash('error_msg', 'This course is not available');
      return res.redirect('/courses');
    }

    // Get related courses from the same teacher
    const relatedCourses = await Course.find({
      _id: { $ne: course._id },
      teacher: course.teacher._id,
      status: 'published',
      isActive: true,
    })
      .populate('teacher', 'firstName lastName teacherCode')
      .limit(4);

    // Get user with purchase information if logged in
    let user = null;
    let isEnrolled = false;
    if (req.session.user) {
      user = await User.findById(req.session.user.id);
      
      // Check if user is enrolled in this course
      if (user) {
        isEnrolled = user.enrolledCourses.some(
          (e) => e.course && e.course.toString() === course._id.toString()
        );
      }
    }

    res.render('course-content', {
      title: `${course.title} | ELKABLY`,
      theme: req.cookies.theme || 'light',
      course,
      relatedCourses,
      user,
      cart: req.session.cart || [],
      isEnrolled,
      coursesWithUnlockStatus: course.topics || [],
    });
  } catch (error) {
    console.error('Error fetching course content:', error);
    if (error.name === 'CastError' || error.message.includes('Cast to ObjectId')) {
      req.flash('error_msg', 'Invalid course ID format');
      return res.redirect('/courses');
    }
    req.flash('error_msg', 'Error loading course content');
    res.redirect('/courses');
  }
};

// Keep for backwards compatibility
const getBundleContent = getCourseContent;

// Get EST test type page
// Mock teacher data (same as index.ejs for consistency)
const mockTeachersData = {
  'math': [
    { id: 'dr-marwa-diab', name: 'Dr. Marwa Diab', image: '/images/place.png', subject: 'Mathematics - Unit 1', specialty: 'IGCSE Mathematics Expert', bio: 'Experienced mathematics teacher with over 10 years of teaching IGCSE and A-Level students.', qualification: 'PhD in Mathematics', language: 'English & Arabic', teachingStyle: 'Interactive & Problem-Solving', courses: 8, students: 450, rating: 4.9, price: 675 },
    { id: 'dr-ahmed-hassan', name: 'Dr. Ahmed Hassan', image: '/images/place.png', subject: 'Mathematics - Unit 4', specialty: 'A-Level Mathematics Specialist', bio: 'Dedicated to making complex mathematical concepts accessible to all students.', qualification: 'MSc in Applied Mathematics', language: 'English & Arabic', teachingStyle: 'Conceptual & Analytical', courses: 6, students: 380, rating: 4.8, price: 740 }
  ],
  'physics': [
    { id: 'dr-yassmin-rakha', name: 'Dr. Yassmin Rakha', image: '/images/place.png', subject: 'OL Edexcel Unit 1', specialty: 'Physics Education Expert', bio: 'Passionate about making physics fun and understandable for IGCSE students.', qualification: 'PhD in Physics Education', language: 'English', teachingStyle: 'Practical & Experimental', courses: 5, students: 320, rating: 4.9, price: 655 }
  ],
  'chemistry': [
    { id: 'dr-samia-elnawagy', name: 'Dr. Samia El Nawagy', image: '/images/place.png', subject: 'A2 Edexcel Unit 6', specialty: 'Organic Chemistry Expert', bio: 'Specializing in A-Level Chemistry with focus on organic chemistry.', qualification: 'PhD in Organic Chemistry', language: 'English & Arabic', teachingStyle: 'Visual & Structured', courses: 7, students: 290, rating: 4.7, price: 510 }
  ],
  'biology': [
    { id: 'dr-sarah-ibrahim', name: 'Dr. Sarah Ibrahim', image: '/images/place.png', subject: 'Biology IGCSE', specialty: 'Biology Curriculum Expert', bio: 'Helping students understand the wonders of life sciences.', qualification: 'MSc in Molecular Biology', language: 'English', teachingStyle: 'Comprehensive & Detailed', courses: 6, students: 410, rating: 4.8, price: 620 }
  ],
  'english': [
    { id: 'ms-nadia-farouk', name: 'Ms. Nadia Farouk', image: '/images/place.png', subject: 'English First Language', specialty: 'English Literature Expert', bio: 'Passionate about English language and literature education.', qualification: 'MA in English Literature', language: 'English', teachingStyle: 'Creative & Engaging', courses: 5, students: 350, rating: 4.9, price: 580 }
  ],
  'ict': [
    { id: 'mr-omar-khaled', name: 'Mr. Omar Khaled', image: '/images/place.png', subject: 'ICT IGCSE', specialty: 'ICT & Technology Expert', bio: 'Making technology accessible and practical for all students.', qualification: 'BSc in Computer Science', language: 'English & Arabic', teachingStyle: 'Hands-on & Practical', courses: 4, students: 280, rating: 4.7, price: 520 }
  ],
  'economics': [
    { id: 'dr-hany-mostafa', name: 'Dr. Hany Mostafa', image: '/images/place.png', subject: 'Economics AS/A2', specialty: 'Economics & Business Expert', bio: 'Bringing real-world economics into the classroom.', qualification: 'PhD in Economics', language: 'English & Arabic', teachingStyle: 'Case-Study Based', courses: 6, students: 310, rating: 4.8, price: 590 }
  ],
  'accounting': [
    { id: 'mr-khaled-hassan', name: 'Mr. Khaled Hassan', image: '/images/place.png', subject: 'Accounting IGCSE', specialty: 'Accounting & Finance Expert', bio: 'Making accounting concepts clear and practical.', qualification: 'CPA, MBA in Finance', language: 'English & Arabic', teachingStyle: 'Practical & Step-by-Step', courses: 5, students: 260, rating: 4.6, price: 540 }
  ],
  'sociology': [
    { id: 'dr-mona-salem', name: 'Dr. Mona Salem', image: '/images/place.png', subject: 'Sociology AS/A2', specialty: 'Sociology Expert', bio: 'Understanding society through critical analysis.', qualification: 'PhD in Sociology', language: 'English', teachingStyle: 'Discussion-Based & Analytical', courses: 4, students: 180, rating: 4.7, price: 500 }
  ],
  'arabic': [
    { id: 'mr-ahmed-elbadawy', name: 'Mr. Ahmed El Badawy', image: '/images/place.png', subject: 'Arabic First Language', specialty: 'Arabic Language Expert', bio: 'Dedicated to excellence in Arabic language education.', qualification: 'MA in Arabic Literature', language: 'Arabic', teachingStyle: 'Traditional & Comprehensive', courses: 5, students: 340, rating: 4.8, price: 480 }
  ],
  'business': [
    { id: 'dr-tarek-mahmoud', name: 'Dr. Tarek Mahmoud', image: '/images/place.png', subject: 'Business Studies IGCSE', specialty: 'Business & Management Expert', bio: 'Bridging academic knowledge with real business practices.', qualification: 'MBA, PhD in Business', language: 'English & Arabic', teachingStyle: 'Case-Study & Interactive', courses: 5, students: 290, rating: 4.7, price: 560 }
  ],
  'computer-science': [
    { id: 'eng-mohamed-ali', name: 'Eng. Mohamed Ali', image: '/images/place.png', subject: 'Computer Science IGCSE', specialty: 'Computer Science Expert', bio: 'Teaching programming and computational thinking.', qualification: 'MSc in Computer Science', language: 'English & Arabic', teachingStyle: 'Project-Based & Coding', courses: 6, students: 320, rating: 4.9, price: 600 }
  ],
  'geography': [
    { id: 'dr-laila-hassan', name: 'Dr. Laila Hassan', image: '/images/place.png', subject: 'Geography IGCSE', specialty: 'Geography Expert', bio: 'Exploring our world through geographical analysis.', qualification: 'PhD in Geography', language: 'English', teachingStyle: 'Visual & Map-Based', courses: 4, students: 220, rating: 4.6, price: 490 }
  ],
  'environmental': [
    { id: 'dr-amira-soliman', name: 'Dr. Amira Soliman', image: '/images/place.png', subject: 'Environmental Management', specialty: 'Environmental Science Expert', bio: 'Understanding and protecting our environment.', qualification: 'PhD in Environmental Science', language: 'English', teachingStyle: 'Research-Based & Practical', courses: 3, students: 150, rating: 4.7, price: 470 }
  ],
  'german': [
    { id: 'mr-peter-schmidt', name: 'Mr. Peter Schmidt', image: '/images/place.png', subject: 'German IGCSE', specialty: 'German Language Expert', bio: 'Native German speaker passionate about language education.', qualification: 'MA in German Studies', language: 'German & English', teachingStyle: 'Immersive & Conversational', courses: 4, students: 120, rating: 4.8, price: 550 }
  ],
  'checkpoint': [
    { id: 'ms-fatma-zakaria', name: 'Ms. Fatma Zakaria', image: '/images/place.png', subject: 'Checkpoint Preparation', specialty: 'Checkpoint Exam Expert', bio: 'Preparing students for checkpoint exams with confidence.', qualification: 'BEd in Education', language: 'English & Arabic', teachingStyle: 'Exam-Focused & Structured', courses: 5, students: 380, rating: 4.9, price: 520 }
  ],
  'combined-science': [
    { id: 'dr-hossam-kamel', name: 'Dr. Hossam Kamel', image: '/images/place.png', subject: 'Combined Science', specialty: 'Combined Science Expert', bio: 'Integrating physics, chemistry, and biology seamlessly.', qualification: 'PhD in Science Education', language: 'English', teachingStyle: 'Integrated & Comprehensive', courses: 6, students: 340, rating: 4.8, price: 580 }
  ],
  'math-american': [
    { id: 'dr-karim-sobhy', name: 'Dr. Karim Sobhy', image: '/images/place.png', subject: 'Math American SAT', specialty: 'SAT Math Expert', bio: 'Helping students achieve their best SAT math scores.', qualification: 'PhD in Mathematics Education', language: 'English & Arabic', teachingStyle: 'Test-Strategy Focused', courses: 5, students: 300, rating: 4.9, price: 650 }
  ]
};

// Helper function to find mock teacher by ID
const findMockTeacher = (teacherId) => {
  for (const subject in mockTeachersData) {
    const teacher = mockTeachersData[subject].find(t => t.id === teacherId);
    if (teacher) {
      return { teacher, subjectKey: subject };
    }
  }
  return null;
};

// Get Teacher Courses page
const getTeacherCourses = async (req, res) => {
  try {
    const { teacherId } = req.params;
    const { subject, examDate, courseType } = req.query;
    
    // Get user if logged in
    const user = req.session.user ? await User.findById(req.session.user.id) : null;
    
    // Find teacher by ID or teacherCode
    let teacher;
    let courses = [];
    let useMockData = false;
    
    if (require('mongoose').Types.ObjectId.isValid(teacherId)) {
      teacher = await Teacher.findById(teacherId);
    } else {
      teacher = await Teacher.findOne({ 
        $or: [
          { teacherCode: teacherId.toUpperCase() },
          { username: teacherId }
        ]
      });
    }
    
    // If no teacher found in DB, try mock data
    if (!teacher) {
      const mockResult = findMockTeacher(teacherId);
      if (mockResult) {
        useMockData = true;
        const mockTeacher = mockResult.teacher;
        
        // Format mock teacher to match template expectations
        teacher = {
          _id: mockTeacher.id,
          name: mockTeacher.name,
          image: mockTeacher.image,
          specialty: mockTeacher.specialty,
          bio: mockTeacher.bio,
          qualification: mockTeacher.qualification,
          language: mockTeacher.language,
          teachingStyle: mockTeacher.teachingStyle,
          totalCourses: mockTeacher.courses,
          totalStudents: mockTeacher.students,
          rating: mockTeacher.rating
        };
        
        // Generate mock courses for this teacher
        courses = generateMockCourses(mockTeacher, subject || mockResult.subjectKey, examDate);
      } else {
        req.flash('error_msg', 'Teacher not found');
        return res.redirect('/');
      }
    } else {
      // Build filter for real courses
      const filter = {
        teacher: teacher._id,
        status: 'published',
        isActive: true,
      };
      
      if (subject) filter.subject = subject;
      if (courseType) filter.courseType = courseType;
      
      // Get teacher's courses from database
      courses = await Course.find(filter)
        .populate('topics')
        .sort({ order: 1, createdAt: -1 });
      
      // Transform real teacher to match template expectations
      teacher = {
        _id: teacher._id,
        name: `${teacher.firstName} ${teacher.lastName}`,
        image: teacher.profilePicture || '/images/place.png',
        specialty: teacher.specialty || 'IGCSE Expert',
        bio: teacher.bio || 'Dedicated to helping students succeed.',
        qualification: teacher.qualification || 'Advanced Degree',
        language: teacher.language || 'English',
        teachingStyle: teacher.teachingStyle || 'Interactive',
        totalCourses: courses.length,
        totalStudents: new Set(courses.flatMap(c => c.enrolledStudents?.map(s => s.toString()) || [])).size
      };
    }
    
    // Format courses for template
    const formattedCourses = courses.map((course, index) => ({
      id: course._id || course.id,
      title: course.title,
      shortDescription: course.shortDescription || course.description || 'Comprehensive course content',
      unit: course.unit || subject || 'Unit 1',
      duration: course.duration || '12 weeks',
      type: course.courseType || course.type || 'online',
      thumbnail: course.thumbnail || '/images/adad.png',
      originalPrice: course.originalPrice || course.price || 700,
      finalPrice: course.finalPrice || course.price || 650,
      discountPercentage: course.discountPercentage || 0,
      lessonsCount: course.lessonsCount || course.topics?.length || 10,
      studentsEnrolled: course.studentsEnrolled || course.enrolledStudents?.length || 50,
      rating: course.rating || 4.8,
      features: course.features || ['Video Lessons', 'Practice Problems', 'Live Support'],
      isBestseller: course.isBestseller || index === 0,
      isNew: course.isNew || false,
      isFullyBooked: course.isFullyBooked || false
    }));
    
    res.render('teacher-courses', {
      title: `${teacher.name} - Courses | G-Teacher`,
      theme: req.cookies.theme || 'light',
      teacher,
      courses: formattedCourses,
      subject: subject || 'Physics',
      examDate: examDate || 'Jan 2026',
      filterOptions: { subjects: [], courseTypes: [] },
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

// Helper function to generate mock courses for a teacher
function generateMockCourses(teacher, subjectKey, examDate) {
  const courseTypes = ['online', 'recorded', 'onground'];
  const courses = [];
  
  for (let i = 1; i <= teacher.courses; i++) {
    courses.push({
      id: `${teacher.id}-course-${i}`,
      title: `${teacher.subject} - Part ${i}`,
      shortDescription: `Comprehensive ${teacher.subject} course covering essential topics for IGCSE/A-Level students.`,
      unit: teacher.subject,
      duration: '8-12 weeks',
      type: courseTypes[i % 3],
      thumbnail: '/images/adad.png',
      originalPrice: teacher.price + 100,
      finalPrice: teacher.price,
      discountPercentage: Math.round((100 / (teacher.price + 100)) * 100),
      lessonsCount: 10 + i,
      studentsEnrolled: Math.floor(teacher.students / teacher.courses),
      rating: teacher.rating,
      features: ['Video Lessons', 'Practice Problems', 'Live Support', 'Exam Preparation'],
      isBestseller: i === 1,
      isNew: i === teacher.courses,
      isFullyBooked: false
    });
  }
  
  return courses;
}

// Keep old function name for backwards compatibility
const getIGTeacherCourses = getTeacherCourses;

module.exports = {
  getLandingPage,
  getOnlineCourses,
  getOngroundCourses,
  getRecordedCourses,
  getRecoveryCourses,
  getBundleContent,
  getCourseContent,
  getTeacherCourses,
  getIGTeacherCourses,
};
