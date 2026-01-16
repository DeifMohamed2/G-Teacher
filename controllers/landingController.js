const BundleCourse = require('../models/BundleCourse');
const Course = require('../models/Course');
const Quiz = require('../models/Quiz');
const User = require('../models/User');
const BrilliantStudent = require('../models/BrilliantStudent');
const GameRoom = require('../models/GameRoom');
const TeamMember = require('../models/TeamMember');

// Get landing page data
const getLandingPage = async (req, res) => {
  try {
    // Execute all database queries in parallel for better performance
    const [
      onlineBundles,
      ongroundBundles,
      recordedBundles,
      recoveryBundles,
      featuredQuizzes,
      testCounts,
      featuredGameRooms,
      stats,
      brilliantStudents,
      teamMembers,
      user
    ] = await Promise.all([
      // Get featured bundles with minimal data
      BundleCourse.find({
        courseType: 'online',
        status: 'published',
        isActive: true,
      })
        .select('title shortDescription price image courseType createdAt')
        .sort({ createdAt: -1 })
        .limit(6)
        .lean(),

      BundleCourse.find({
        courseType: 'onground',
        status: 'published',
        isActive: true,
      })
        .select('title shortDescription price image courseType createdAt')
        .sort({ createdAt: -1 })
        .limit(6)
        .lean(),

      BundleCourse.find({
        courseType: 'recorded',
        status: 'published',
        isActive: true,
      })
        .select('title shortDescription price image courseType createdAt')
        .sort({ createdAt: -1 })
        .limit(6)
        .lean(),

      BundleCourse.find({
        courseType: 'recovery',
        status: 'published',
        isActive: true,
      })
        .select('title shortDescription price image courseType createdAt')
        .sort({ createdAt: -1 })
        .limit(6)
        .lean(),

      // Get featured quizzes with minimal data
      Quiz.find({
        status: 'active',
      })
        .select('title description testType difficulty timeLimit totalQuestions createdAt')
        .sort({ createdAt: -1 })
        .limit(4)
        .lean(),

      // Get test counts in parallel
      Promise.all([
        Quiz.countDocuments({ testType: 'EST', status: 'active' }),
        Quiz.countDocuments({ testType: 'SAT', status: 'active' }),
        Quiz.countDocuments({ testType: 'ACT', status: 'active' }),
      ]).then(([EST, SAT, ACT]) => ({ EST, SAT, ACT })),

      // Get featured game rooms with minimal data
      GameRoom.find({
        isActive: true,
        isPublic: true,
        gameState: { $in: ['waiting', 'starting'] },
      })
        .select('title gameState currentPlayers maxPlayers totalTime questions category difficulty createdAt')
        .sort({ createdAt: -1 })
        .limit(6)
        .lean(),

      // Get stats in parallel
      Promise.all([
        BundleCourse.countDocuments({
          courseType: 'online',
          status: 'published',
          isActive: true,
        }),
        BundleCourse.countDocuments({
          courseType: 'onground',
          status: 'published',
          isActive: true,
        }),
        BundleCourse.countDocuments({
          courseType: 'recorded',
          status: 'published',
          isActive: true,
        }),
        BundleCourse.countDocuments({
          courseType: 'recovery',
          status: 'published',
          isActive: true,
        }),
        Quiz.countDocuments({ status: 'active' }),
        GameRoom.countDocuments({
          isActive: true,
          isPublic: true,
        }),
        BundleCourse.aggregate([
          { $match: { status: 'published', isActive: true } },
          { $project: { enrolledCount: { $size: '$enrolledStudents' } } },
          { $group: { _id: null, total: { $sum: '$enrolledCount' } } },
        ])
      ]).then(([onlineBundles, ongroundBundles, recordedBundles, recoveryBundles, totalQuizzes, totalGameRooms, totalStudents]) => ({
        onlineBundles,
        ongroundBundles,
        recordedBundles,
        recoveryBundles,
        totalQuizzes,
        totalGameRooms,
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
      req.session.user ? User.findById(req.session.user.id): null
    ]);



    res.render('index', {
      title: 'Home | ELKABLY',
      theme: req.cookies.theme || 'light',
      onlineBundles,
      ongroundBundles,
      recordedBundles,
      recoveryBundles,
      featuredQuizzes,
      featuredGameRooms,
      user,
      cart: req.session.cart || [],
      testCounts,
      brilliantStudents,
      teamMembers,
      stats,
    });
  } catch (error) {
    console.error('Error fetching landing page data:', error);
    res.render('index', {
      title: 'Home | ELKABLY',
      theme: req.cookies.theme || 'light',
      onlineBundles: [],
      ongroundBundles: [],
      recordedBundles: [],
      recoveryBundles: [],
      featuredQuizzes: [],
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

// Get online courses page
const getOnlineCourses = async (req, res) => {
  try {
    const { page = 1, limit = 12, search, subject, testType } = req.query;

    const filter = {
      courseType: 'online',
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

    console.log('Online courses filter:', filter);

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const bundles = await BundleCourse.find(filter)
      .populate('courses')
      .populate('createdBy', 'userName')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    console.log('Found online bundles:', bundles.length);

    const totalBundles = await BundleCourse.countDocuments(filter);
    const totalPages = Math.ceil(totalBundles / parseInt(limit));

    // Get filter options
    const subjects = await BundleCourse.distinct('subject', {
      courseType: 'online',
      status: 'published',
      isActive: true,
    });
    const testTypes = await BundleCourse.distinct('testType', {
      courseType: 'online',
      status: 'published',
      isActive: true,
    });

    // Get user with purchase information if logged in
    let user = null;
    if (req.session.user) {
      user = await User.findById(req.session.user.id);
      // .populate('wishlist.courses')
      // .populate('wishlist.bundles');
      // .populate('purchasedBundles.bundle')
      // .populate('purchasedCourses.course')
      // .populate('enrolledCourses.course');
    }

    res.render('online-courses', {
      title: 'Online Courses | ELKABLY',
      theme: req.cookies.theme || 'light',
      bundles,
      user,
      cart: req.session.cart || [],
      filterOptions: { subjects, testTypes },
      currentFilters: { search, subject, testType },
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalBundles,
        hasNext: parseInt(page) < totalPages,
        hasPrev: parseInt(page) > 1,
      },
    });
  } catch (error) {
    console.error('Error fetching online courses:', error);
    req.flash('error_msg', 'Error loading online courses');
    res.render('online-courses', {
      title: 'Online Courses | ELKABLY',
      theme: req.cookies.theme || 'light',
      bundles: [],
      cart: req.session.cart || [],
      filterOptions: { subjects: [], testTypes: [] },
      currentFilters: {},
      pagination: {
        currentPage: 1,
        totalPages: 0,
        totalBundles: 0,
        hasNext: false,
        hasPrev: false,
      },
    });
  }
};

// Get onground courses page
const getOngroundCourses = async (req, res) => {
  try {
    const { page = 1, limit = 12, search, subject, testType } = req.query;

    const filter = {
      courseType: 'onground',
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

    console.log('Onground courses filter:', filter);

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const bundles = await BundleCourse.find(filter)
      .populate('courses')
      .populate('createdBy', 'userName')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    console.log('Found onground bundles:', bundles.length);

    const totalBundles = await BundleCourse.countDocuments(filter);
    const totalPages = Math.ceil(totalBundles / parseInt(limit));

    // Get filter options
    const subjects = await BundleCourse.distinct('subject', {
      courseType: 'onground',
      status: 'published',
      isActive: true,
    });
    const testTypes = await BundleCourse.distinct('testType', {
      courseType: 'onground',
      status: 'published',
      isActive: true,
    });

    // Get user with purchase information if logged in
    let user = null;
    if (req.session.user) {
      user = await User.findById(req.session.user.id);
      // .populate('wishlist.courses')
      // .populate('wishlist.bundles');
      // .populate('purchasedBundles.bundle')
      // .populate('purchasedCourses.course')
      // .populate('enrolledCourses.course');
    }

    res.render('onground-courses', {
      title: 'On-Ground Courses | ELKABLY',
      theme: req.cookies.theme || 'light',
      bundles,
      user,
      cart: req.session.cart || [],
      filterOptions: { subjects, testTypes },
      currentFilters: { search, subject, testType },
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalBundles,
        hasNext: parseInt(page) < totalPages,
        hasPrev: parseInt(page) > 1,
      },
    });
  } catch (error) {
    console.error('Error fetching onground courses:', error);
    req.flash('error_msg', 'Error loading onground courses');
    res.render('onground-courses', {
      title: 'On-Ground Courses | ELKABLY',
      theme: req.cookies.theme || 'light',
      bundles: [],
      cart: req.session.cart || [],
      filterOptions: { subjects: [], testTypes: [] },
      currentFilters: {},
      pagination: {
        currentPage: 1,
        totalPages: 0,
        totalBundles: 0,
        hasNext: false,
        hasPrev: false,
      },
    });
  }
};

// Get recorded courses page
const getRecordedCourses = async (req, res) => {
  try {
    const { page = 1, limit = 12, search, subject, testType } = req.query;

    const filter = {
      courseType: 'recorded',
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

    console.log('Recorded courses filter:', filter);

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const bundles = await BundleCourse.find(filter)
      .populate('courses')
      .populate('createdBy', 'userName')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    console.log('Found recorded bundles:', bundles.length);

    const totalBundles = await BundleCourse.countDocuments(filter);
    const totalPages = Math.ceil(totalBundles / parseInt(limit));

    // Get filter options
    const subjects = await BundleCourse.distinct('subject', {
      courseType: 'recorded',
      status: 'published',
      isActive: true,
    });
    const testTypes = await BundleCourse.distinct('testType', {
      courseType: 'recorded',
      status: 'published',
      isActive: true,
    });

    // Get user with purchase information if logged in
    let user = null;
    if (req.session.user) {
      user = await User.findById(req.session.user.id);
    }

    res.render('recorded-courses', {
      title: 'Recorded Courses | ELKABLY',
      theme: req.cookies.theme || 'light',
      bundles,
      user,
      cart: req.session.cart || [],
      filterOptions: { subjects, testTypes },
      currentFilters: { search, subject, testType },
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalBundles,
        hasNext: parseInt(page) < totalPages,
        hasPrev: parseInt(page) > 1,
      },
    });
  } catch (error) {
    console.error('Error fetching recorded courses:', error);
    req.flash('error_msg', 'Error loading recorded courses');
    res.render('recorded-courses', {
      title: 'Recorded Courses | ELKABLY',
      theme: req.cookies.theme || 'light',
      bundles: [],
      cart: req.session.cart || [],
      filterOptions: { subjects: [], testTypes: [] },
      currentFilters: {},
      pagination: {
        currentPage: 1,
        totalPages: 0,
        totalBundles: 0,
        hasNext: false,
        hasPrev: false,
      },
    });
  }
};

// Get recovery courses page
const getRecoveryCourses = async (req, res) => {
  try {
    const { page = 1, limit = 12, search, subject, testType } = req.query;

    const filter = {
      courseType: 'recovery',
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

    console.log('Recovery courses filter:', filter);

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const bundles = await BundleCourse.find(filter)
      .populate('courses')
      .populate('createdBy', 'userName')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    console.log('Found recovery bundles:', bundles.length);

    const totalBundles = await BundleCourse.countDocuments(filter);
    const totalPages = Math.ceil(totalBundles / parseInt(limit));

    // Get filter options
    const subjects = await BundleCourse.distinct('subject', {
      courseType: 'recovery',
      status: 'published',
      isActive: true,
    });
    const testTypes = await BundleCourse.distinct('testType', {
      courseType: 'recovery',
      status: 'published',
      isActive: true,
    });

    // Get user with purchase information if logged in
    let user = null;
    if (req.session.user) {
      user = await User.findById(req.session.user.id);
    }

    res.render('recovery-courses', {
      title: 'Recovery Courses | ELKABLY',
      theme: req.cookies.theme || 'light',
      bundles,
      user,
      cart: req.session.cart || [],
      filterOptions: { subjects, testTypes },
      currentFilters: { search, subject, testType },
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalBundles,
        hasNext: parseInt(page) < totalPages,
        hasPrev: parseInt(page) > 1,
      },
    });
  } catch (error) {
    console.error('Error fetching recovery courses:', error);
    req.flash('error_msg', 'Error loading recovery courses');
    res.render('recovery-courses', {
      title: 'Recovery Courses | ELKABLY',
      theme: req.cookies.theme || 'light',
      bundles: [],
      cart: req.session.cart || [],
      filterOptions: { subjects: [], testTypes: [] },
      currentFilters: {},
      pagination: {
        currentPage: 1,
        totalPages: 0,
        totalBundles: 0,
        hasNext: false,
        hasPrev: false,
      },
    });
  }
};

// Get bundle course content (all courses in the bundle)
const getBundleContent = async (req, res) => {
  try {
    const { id } = req.params;

    // Validate ID format
    if (!id || !require('mongoose').Types.ObjectId.isValid(id)) {
      req.flash('error_msg', 'Invalid bundle ID');
      return res.redirect('/courses');
    }

    const bundle = await BundleCourse.findById(id)
      .populate('courses')
      .populate('createdBy', 'userName')
      .populate('enrolledStudents', 'userName email');

    if (!bundle) {
      req.flash('error_msg', 'Bundle course not found');
      return res.redirect('/courses');
    }

    if (bundle.status !== 'published' || !bundle.isActive) {
      req.flash('error_msg', 'This bundle course is not available');
      return res.redirect('/courses');
    }

    // Get related bundles
    const relatedBundles = await BundleCourse.find({
      _id: { $ne: bundle._id },
      courseType: bundle.courseType,
      status: 'published',
      isActive: true,
    })
      .populate('courses')
      .limit(4);

    // Get user with purchase information if logged in
    let user = null;
    let coursesWithUnlockStatus = [];
    if (req.session.user) {
      user = await User.findById(req.session.user.id);
      // .populate('wishlist.courses')
      // .populate('wishlist.bundles');
      // .populate('purchasedBundles.bundle')
      // .populate('purchasedCourses.course')
      // .populate('enrolledCourses.course');
      
      // Check unlock status for each course in the bundle
      if (bundle.courses && bundle.courses.length > 0) {
        const Course = require('../models/Course');
        coursesWithUnlockStatus = await Promise.all(
          bundle.courses.map(async (course) => {
            const unlockStatus = await Course.isCourseUnlocked(user._id, course._id);
            return {
              ...course.toObject(),
              isUnlocked: unlockStatus.unlocked,
              unlockReason: unlockStatus.reason,
            };
          })
        );
      }
    } else {
      // If not logged in, just use courses as-is
      coursesWithUnlockStatus = bundle.courses || [];
    }

    res.render('bundle-content', {
      title: `${bundle.title} | ELKABLY`,
      theme: req.cookies.theme || 'light',
      bundle,
      relatedBundles,
      user,
      cart: req.session.cart || [],
      coursesWithUnlockStatus: coursesWithUnlockStatus.length > 0 ? coursesWithUnlockStatus : bundle.courses,
    });
  } catch (error) {
    console.error('Error fetching bundle content:', error);
    // If it's a CastError (invalid ObjectId), show specific message
    if (error.name === 'CastError' || error.message.includes('Cast to ObjectId')) {
      req.flash('error_msg', 'Invalid bundle ID format');
      return res.redirect('/courses');
    }
    req.flash('error_msg', 'Error loading bundle content');
    res.redirect('/courses');
  }
};

// Get EST test type page
const getESTTests = async (req, res) => {
  try {
    const { page = 1, limit = 12, search, difficulty } = req.query;
    const skip = (page - 1) * limit;

    const filter = {
      testType: 'EST',
      status: 'active',
      isDeleted: { $ne: true },
    };

    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ];
    }
    if (difficulty) filter.difficulty = difficulty;

    const quizzes = await Quiz.find(filter)
      .populate('questionBank', 'name bankCode description totalQuestions')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean({ virtuals: true });

    const total = await Quiz.countDocuments(filter);
    const totalPages = Math.ceil(total / limit);

    // Get filter options
    const difficulties = await Quiz.distinct('difficulty', {
      testType: 'EST',
      status: 'active',
    });

    const user = req.session.user || null;

    res.render('test-type', {
      title: 'EST Test Preparation | ELKABLY',
      theme: req.cookies.theme || 'light',
      testType: 'EST',
      testTypeName: 'Egyptian Scholastic Test',
      testTypeDescription:
        'Comprehensive preparation for the Egyptian Scholastic Test with math and science focus',
      quizzes,
      user,
      cart: req.session.cart || [],
      filterOptions: { difficulties },
      currentFilters: { search, difficulty },
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
        nextPage: page < totalPages ? parseInt(page) + 1 : null,
        prevPage: page > 1 ? parseInt(page) - 1 : null,
      },
    });
  } catch (error) {
    console.error('Error fetching EST tests:', error);
    res.status(500).render('500', {
      title: 'Server Error',
      theme: req.cookies.theme || 'light',
      error: 'Failed to load EST tests',
    });
  }
};

// Get SAT test type page
const getSATTests = async (req, res) => {
  try {
    const { page = 1, limit = 12, search, difficulty } = req.query;
    const skip = (page - 1) * limit;

    const filter = {
      testType: 'SAT',
      status: 'active',
      isDeleted: { $ne: true },
    };

    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ];
    }
    if (difficulty) filter.difficulty = difficulty;

    const quizzes = await Quiz.find(filter)
      .populate('questionBank', 'name bankCode description totalQuestions')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean({ virtuals: true });

    const total = await Quiz.countDocuments(filter);
    const totalPages = Math.ceil(total / limit);

    // Get filter options
    const difficulties = await Quiz.distinct('difficulty', {
      testType: 'SAT',
      status: 'active',
    });

    const user = req.session.user || null;

    res.render('test-type', {
      title: 'SAT Test Preparation | ELKABLY',
      theme: req.cookies.theme || 'light',
      testType: 'SAT',
      testTypeName: 'Scholastic Assessment Test',
      testTypeDescription:
        'Comprehensive preparation for the Scholastic Assessment Test for college admissions',
      quizzes,
      user,
      cart: req.session.cart || [],
      filterOptions: { difficulties },
      currentFilters: { search, difficulty },
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
        nextPage: page < totalPages ? parseInt(page) + 1 : null,
        prevPage: page > 1 ? parseInt(page) - 1 : null,
      },
    });
  } catch (error) {
    console.error('Error fetching SAT tests:', error);
    res.status(500).render('500', {
      title: 'Server Error',
      theme: req.cookies.theme || 'light',
      error: 'Failed to load SAT tests',
    });
  }
};

// Get ACT test type page
const getACTTests = async (req, res) => {
  try {
    const { page = 1, limit = 12, search, difficulty } = req.query;
    const skip = (page - 1) * limit;

    const filter = {
      testType: 'ACT',
      status: 'active',
      isDeleted: { $ne: true },
    };

    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ];
    }
    if (difficulty) filter.difficulty = difficulty;

    const quizzes = await Quiz.find(filter)
      .populate('questionBank', 'name bankCode description totalQuestions')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean({ virtuals: true });

    const total = await Quiz.countDocuments(filter);
    const totalPages = Math.ceil(total / limit);

    // Get filter options
    const difficulties = await Quiz.distinct('difficulty', {
      testType: 'ACT',
      status: 'active',
    });

    const user = req.session.user || null;

    res.render('test-type', {
      title: 'ACT Test Preparation | ELKABLY',
      theme: req.cookies.theme || 'light',
      testType: 'ACT',
      testTypeName: 'American College Testing',
      testTypeDescription:
        'Comprehensive preparation for the American College Testing with science reasoning',
      quizzes,
      user,
      cart: req.session.cart || [],
      filterOptions: { difficulties },
      currentFilters: { search, difficulty },
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
        nextPage: page < totalPages ? parseInt(page) + 1 : null,
        prevPage: page > 1 ? parseInt(page) - 1 : null,
      },
    });
  } catch (error) {
    console.error('Error fetching ACT tests:', error);
    res.status(500).render('500', {
      title: 'Server Error',
      theme: req.cookies.theme || 'light',
      error: 'Failed to load ACT tests',
    });
  }
};

// Get IG Teacher Courses page (with temporary mock data)
const getIGTeacherCourses = async (req, res) => {
  try {
    const { teacherId } = req.params;
    const { subject, examDate } = req.query;
    
    // Get user if logged in
    const User = require('../models/User');
    const user = req.session.user ? await User.findById(req.session.user.id) : null;
    
    // Temporary mock data for teachers
    const teachersData = {
      'dr-marwa-diab': {
        id: 'dr-marwa-diab',
        name: 'Dr. Marwa Diab',
        image: '/images/place.png',
        specialty: 'Mathematics IGCSE & A-Level Expert',
        bio: 'Dr. Marwa Diab has over 15 years of experience teaching Mathematics at the IGCSE and A-Level. She has helped thousands of students achieve top grades and is known for her clear explanations and engaging teaching style.',
        rating: 4.9,
        totalCourses: 8,
        totalStudents: 450,
        yearsExperience: 15,
        credentials: 'Cambridge Certified',
        qualification: 'PhD in Mathematics Education',
        language: 'English & Arabic',
        teachingStyle: 'Interactive & Visual'
      },
      'dr-ahmed-hassan': {
        id: 'dr-ahmed-hassan',
        name: 'Dr. Ahmed Hassan',
        image: '/images/place.png',
        specialty: 'Mathematics Unit 4 Specialist',
        bio: 'Dr. Ahmed Hassan specializes in advanced mathematics topics and has extensive experience preparing students for challenging examinations.',
        rating: 4.8,
        totalCourses: 6,
        totalStudents: 380,
        yearsExperience: 12,
        credentials: 'Edexcel Examiner',
        qualification: 'MSc in Applied Mathematics',
        language: 'English & Arabic',
        teachingStyle: 'Problem-Solving Focus'
      },
      'dr-yassmin-rakha': {
        id: 'dr-yassmin-rakha',
        name: 'Dr. Yassmin Rakha',
        image: '/images/place.png',
        specialty: 'Physics OL Edexcel Specialist',
        bio: 'Dr. Yassmin Rakha brings physics to life with practical examples and experiments. Her students consistently achieve outstanding results.',
        rating: 4.9,
        totalCourses: 5,
        totalStudents: 320,
        yearsExperience: 10,
        credentials: 'Edexcel Approved',
        qualification: 'PhD in Physics',
        language: 'English & Arabic',
        teachingStyle: 'Practical & Experimental'
      },
      'dr-samia-elnawagy': {
        id: 'dr-samia-elnawagy',
        name: 'Dr. Samia El Nawagy',
        image: '/images/place.png',
        specialty: 'Chemistry A2 Edexcel Expert',
        bio: 'Dr. Samia El Nawagy is a chemistry expert with a passion for making complex concepts simple and understandable.',
        rating: 4.7,
        totalCourses: 7,
        totalStudents: 290,
        yearsExperience: 14,
        credentials: 'Cambridge Examiner',
        qualification: 'PhD in Chemistry',
        language: 'English & Arabic',
        teachingStyle: 'Concept-Based Learning'
      }
    };
    
    // Get teacher data or use default
    const teacher = teachersData[teacherId] || {
      id: teacherId,
      name: 'Expert Teacher',
      image: '/images/place.png',
      specialty: 'IGCSE Specialist',
      bio: 'An experienced teacher dedicated to helping students achieve their academic goals.',
      rating: 4.5,
      totalCourses: 5,
      totalStudents: 200,
      yearsExperience: 8,
      credentials: 'Certified Teacher',
      qualification: 'Master\'s Degree',
      language: 'English & Arabic',
      teachingStyle: 'Interactive Learning'
    };
    
    // Mock courses data
    const courses = [
      {
        id: 'course-1',
        title: 'Complete Unit 1 Course',
        shortDescription: 'Master all topics in Unit 1 with comprehensive lessons, practice problems, and exam preparation.',
        thumbnail: '/images/courses/course-1.jpg',
        type: 'online',
        unit: 'Unit 1',
        duration: '12 weeks',
        lessonsCount: 24,
        studentsEnrolled: 156,
        rating: 4.9,
        originalPrice: 800,
        finalPrice: 675,
        discountPercentage: 15,
        features: ['Live Sessions', 'Recorded Videos', 'Practice Tests', 'WhatsApp Support'],
        isBestseller: true,
        isNew: false,
        isFullyBooked: false
      },
      {
        id: 'course-2',
        title: 'Unit 2 Intensive Course',
        shortDescription: 'Intensive preparation for Unit 2 covering all key concepts and exam techniques.',
        thumbnail: '/images/courses/course-2.jpg',
        type: 'recorded',
        unit: 'Unit 2',
        duration: '8 weeks',
        lessonsCount: 16,
        studentsEnrolled: 98,
        rating: 4.8,
        originalPrice: 600,
        finalPrice: 540,
        discountPercentage: 10,
        features: ['HD Videos', 'PDF Notes', 'Quizzes', 'Certificate'],
        isBestseller: false,
        isNew: true,
        isFullyBooked: false
      },
      {
        id: 'course-3',
        title: 'Exam Revision Bootcamp',
        shortDescription: 'Intensive exam preparation with past paper analysis and exam strategies.',
        thumbnail: '/images/courses/course-3.jpg',
        type: 'online',
        unit: 'All Units',
        duration: '4 weeks',
        lessonsCount: 12,
        studentsEnrolled: 234,
        rating: 4.9,
        originalPrice: 450,
        finalPrice: 450,
        discountPercentage: 0,
        features: ['Past Papers', 'Model Answers', 'Tips & Tricks', 'Mock Exams'],
        isBestseller: true,
        isNew: false,
        isFullyBooked: false
      },
      {
        id: 'course-4',
        title: 'One-on-One Tutoring Package',
        shortDescription: 'Personalized tutoring sessions tailored to your specific needs and learning pace.',
        thumbnail: '/images/courses/course-4.jpg',
        type: 'onground',
        unit: 'Custom',
        duration: '10 sessions',
        lessonsCount: 10,
        studentsEnrolled: 45,
        rating: 5.0,
        originalPrice: 1500,
        finalPrice: 1350,
        discountPercentage: 10,
        features: ['1-on-1 Sessions', 'Flexible Timing', 'Personalized Plan', 'Progress Reports'],
        isBestseller: false,
        isNew: false,
        isFullyBooked: true
      },
      {
        id: 'course-5',
        title: 'Topic-by-Topic Mastery',
        shortDescription: 'Deep dive into each topic with detailed explanations and extensive practice.',
        thumbnail: '/images/courses/course-5.jpg',
        type: 'recorded',
        unit: 'All Topics',
        duration: '16 weeks',
        lessonsCount: 48,
        studentsEnrolled: 189,
        rating: 4.7,
        originalPrice: 950,
        finalPrice: 760,
        discountPercentage: 20,
        features: ['Lifetime Access', 'Downloadable', 'Mobile App', 'Community Access'],
        isBestseller: false,
        isNew: false,
        isFullyBooked: false
      },
      {
        id: 'course-6',
        title: 'Weekend Intensive Workshop',
        shortDescription: 'Full-day weekend workshops covering critical exam topics and techniques.',
        thumbnail: '/images/courses/course-6.jpg',
        type: 'onground',
        unit: 'Key Topics',
        duration: '4 weekends',
        lessonsCount: 8,
        studentsEnrolled: 60,
        rating: 4.8,
        originalPrice: 400,
        finalPrice: 350,
        discountPercentage: 12,
        features: ['In-Person', 'Small Groups', 'Printed Materials', 'Refreshments'],
        isBestseller: false,
        isNew: true,
        isFullyBooked: false
      }
    ];
    
    // Special offers
    const specialOffers = [
      {
        courseId: 'course-1',
        title: 'Early Bird Special - Unit 1',
        description: 'Register before the end of the month and save 20%!',
        originalPrice: 800,
        discountedPrice: 640,
        discountPercentage: 20
      },
      {
        courseId: 'course-5',
        title: 'Flash Sale - Topic Mastery',
        description: 'Limited time offer - 48 hours only!',
        originalPrice: 950,
        discountedPrice: 665,
        discountPercentage: 30
      }
    ];
    
    // Bundle packages
    const bundles = [
      {
        id: 'bundle-1',
        title: 'Complete Course Bundle',
        description: 'Get access to all courses and save big!',
        includedCourses: ['Complete Unit 1 Course', 'Unit 2 Intensive Course', 'Exam Revision Bootcamp'],
        originalPrice: 1850,
        finalPrice: 1295,
        savingsPercentage: 30
      },
      {
        id: 'bundle-2',
        title: 'Recorded Courses Pack',
        description: 'All recorded courses with lifetime access.',
        includedCourses: ['Unit 2 Intensive Course', 'Topic-by-Topic Mastery'],
        originalPrice: 1550,
        finalPrice: 1085,
        savingsPercentage: 30
      }
    ];
    
    // Format exam date for display
    const examDateDisplay = examDate ? examDate.replace(/-/g, ' ').replace(/(\w)(\w*)/g, (_, first, rest) => first.toUpperCase() + rest) : 'January 2026';
    
    // Format subject for display
    const subjectDisplay = subject ? subject.replace(/-/g, ' ').replace(/(\w)(\w*)/g, (_, first, rest) => first.toUpperCase() + rest) : 'Mathematics';
    
    res.render('teacher-courses', {
      title: `${teacher.name} - ${subjectDisplay} Courses | G-Teacher`,
      theme: req.cookies.theme || 'light',
      teacher,
      subject: subjectDisplay,
      examDate: examDateDisplay,
      courses,
      specialOffers,
      bundles,
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

module.exports = {
  getLandingPage,
  getOnlineCourses,
  getOngroundCourses,
  getRecordedCourses,
  getRecoveryCourses,
  getBundleContent,
  getESTTests,
  getSATTests,
  getACTTests,
  getIGTeacherCourses,
};