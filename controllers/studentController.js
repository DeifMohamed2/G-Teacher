const User = require('../models/User');
const Course = require('../models/Course');
const Progress = require('../models/Progress');
const Teacher = require('../models/Teacher');
const Topic = require('../models/Topic');
const ZoomMeeting = require('../models/ZoomMeeting');
const mongoose = require('mongoose');
const zoomService = require('../utils/zoomService');
const whatsappSMSNotificationService = require('../utils/whatsappSMSNotificationService');

// Dashboard - Main student dashboard
const dashboard = async (req, res) => {
  try {
    const studentId = req.session.user.id;
    const selectedTeacherId = req.query.teacher || req.session.selectedTeacher || null;

    // Get student with populated data
    const student = await User.findById(studentId)
      .populate({
        path: 'enrolledCourses.course',
        populate: [
          {
            path: 'topics',
            model: 'Topic',
          },
          {
            path: 'teacher',
            select: 'firstName lastName teacherCode profilePicture subject',
            model: 'Teacher',
          },
        ],
      })
      .populate('wishlist');

    if (!student) {
      req.flash('error_msg', 'Student not found');
      return res.redirect('/auth/login');
    }

    // Extract unique teachers from enrolled courses
    const teachersMap = new Map();
    student.enrolledCourses.forEach((enrollment) => {
      if (enrollment.course && enrollment.course.teacher) {
        const teacher = enrollment.course.teacher;
        if (!teachersMap.has(teacher._id.toString())) {
          // Count courses for this teacher
          const teacherCourses = student.enrolledCourses.filter(
            (e) => e.course && e.course.teacher && e.course.teacher._id.toString() === teacher._id.toString()
          );
          teachersMap.set(teacher._id.toString(), {
            _id: teacher._id,
            firstName: teacher.firstName,
            lastName: teacher.lastName,
            teacherCode: teacher.teacherCode,
            profilePicture: teacher.profilePicture,
            subject: teacher.subject,
            courseCount: teacherCourses.length,
          });
        }
      }
    });
    const availableTeachers = Array.from(teachersMap.values());

    // Store selected teacher in session
    if (req.query.teacher) {
      req.session.selectedTeacher = req.query.teacher;
    }

    // Filter courses by selected teacher
    let filteredEnrollments = student.enrolledCourses.filter(
      (enrollment) => enrollment.status === 'active' && enrollment.course
    );

    if (selectedTeacherId && selectedTeacherId !== 'all') {
      filteredEnrollments = filteredEnrollments.filter(
        (enrollment) =>
          enrollment.course.teacher &&
          enrollment.course.teacher._id.toString() === selectedTeacherId
      );
    }

    // Get recent progress (filtered by teacher if selected)
    let progressFilter = { student: studentId };
    if (selectedTeacherId && selectedTeacherId !== 'all') {
      // Get course IDs for this teacher
      const teacherCourseIds = filteredEnrollments.map((e) => e.course._id);
      progressFilter.course = { $in: teacherCourseIds };
    }

    const recentProgress = await Progress.find(progressFilter)
      .populate('course', 'title thumbnail teacher')
      .populate('topic', 'title')
      .sort({ timestamp: -1 })
      .limit(10);

    // Get statistics (filtered by teacher if selected)
    const filteredCoursesList = filteredEnrollments.map((e) => e.course);
    const stats = {
      totalCourses: filteredEnrollments.length,
      completedCourses: filteredEnrollments.filter((e) => e.progress === 100).length,
      totalPoints: 0,
      wishlistCount: student.wishlist ? student.wishlist.length : 0,
    };

    // Get active courses (recently accessed, filtered by teacher)
    const activeCourses = filteredEnrollments
      .sort((a, b) => new Date(b.lastAccessed) - new Date(a.lastAccessed))
      .slice(0, 6)
      .map((enrollment) => ({
        ...enrollment.course.toObject(),
        progress: enrollment.progress,
        lastAccessed: enrollment.lastAccessed,
        status: enrollment.status,
      }));

    // Get selected teacher info
    const selectedTeacher = selectedTeacherId && selectedTeacherId !== 'all'
      ? availableTeachers.find((t) => t._id.toString() === selectedTeacherId)
      : null;

    res.render('student/dashboard', {
      title: selectedTeacher
        ? `${selectedTeacher.firstName} ${selectedTeacher.lastName} - Dashboard | ELKABLY`
        : 'Student Dashboard | ELKABLY',
      student,
      stats,
      recentProgress,
      activeCourses,
      availableTeachers,
      selectedTeacherId: selectedTeacherId || 'all',
      selectedTeacher,
      theme: req.cookies.theme || student.preferences?.theme || 'light',
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    req.flash('error_msg', 'Error loading dashboard');
    res.redirect('/auth/login');
  }
};

// Enrolled Courses - View all enrolled courses with filtering
const enrolledCourses = async (req, res) => {
  try {
    const studentId = req.session.user.id;

    // Get filter parameters
    const searchQuery = req.query.search || '';
    const progressFilter = req.query.progress || 'all';
    const teacherFilter = req.query.teacher || req.session.selectedTeacher || 'all';
    const sortBy = req.query.sort || 'lastAccessed';

    // Store selected teacher in session
    if (req.query.teacher) {
      req.session.selectedTeacher = req.query.teacher;
    }

    const student = await User.findById(studentId).populate({
      path: 'enrolledCourses.course',
      populate: [
        {
          path: 'topics',
          model: 'Topic',
        },
        {
          path: 'teacher',
          select: 'firstName lastName teacherCode profilePicture subject',
          model: 'Teacher',
        },

      ],
    });

    if (!student) {
      req.flash('error_msg', 'Student not found');
      return res.redirect('/auth/login');
    }

    // Filter out enrollments with null/deleted courses
    const validEnrollments = student.enrolledCourses.filter(
      (enrollment) => enrollment.course
    );

    // Update the student's enrolled courses to only include valid ones if needed
    if (validEnrollments.length !== student.enrolledCourses.length) {
      student.enrolledCourses = validEnrollments;
      await student.save();
    }

    // Extract unique teachers from enrolled courses
    const teachersMap = new Map();
    validEnrollments.forEach((enrollment) => {
      if (enrollment.course && enrollment.course.teacher) {
        const teacher = enrollment.course.teacher;
        if (!teachersMap.has(teacher._id.toString())) {
          const teacherCourses = validEnrollments.filter(
            (e) => e.course && e.course.teacher && e.course.teacher._id.toString() === teacher._id.toString()
          );
          teachersMap.set(teacher._id.toString(), {
            _id: teacher._id,
            firstName: teacher.firstName,
            lastName: teacher.lastName,
            teacherCode: teacher.teacherCode,
            profilePicture: teacher.profilePicture,
            subject: teacher.subject,
            courseCount: teacherCourses.length,
          });
        }
      }
    });
    const availableTeachers = Array.from(teachersMap.values());

    // Apply filters
    let filteredCourses = validEnrollments;

    // Filter by teacher
    if (teacherFilter !== 'all') {
      filteredCourses = filteredCourses.filter(
        (enrollment) =>
          enrollment.course.teacher &&
          enrollment.course.teacher._id.toString() === teacherFilter
      );
    }

    // Search by course name
    if (searchQuery) {
      filteredCourses = filteredCourses.filter((enrollment) =>
        enrollment.course.title
          .toLowerCase()
          .includes(searchQuery.toLowerCase())
      );
    }

    // Filter by progress percentage
    if (progressFilter !== 'all') {
      filteredCourses = filteredCourses.filter((enrollment) => {
        const progress = enrollment.progress || 0;
        switch (progressFilter) {
          case 'not-started':
            return progress === 0;
          case 'in-progress':
            return progress > 0 && progress < 100;
          case 'completed':
            return progress === 100;
          case 'high-progress':
            return progress >= 75;
          case 'low-progress':
            return progress < 25;
          default:
            return true;
        }
      });
    }

    // Sort courses
    switch (sortBy) {
      case 'name':
        filteredCourses.sort((a, b) =>
          a.course.title.localeCompare(b.course.title)
        );
        break;
      case 'progress':
        filteredCourses.sort((a, b) => (b.progress || 0) - (a.progress || 0));
        break;
      case 'enrolledAt':
        filteredCourses.sort(
          (a, b) => new Date(b.enrolledAt) - new Date(a.enrolledAt)
        );
        break;
      case 'lastAccessed':
      default:
        filteredCourses.sort(
          (a, b) => new Date(b.lastAccessed) - new Date(a.lastAccessed)
        );
        break;
    }

    // Display all results without pagination
    const totalCourses = filteredCourses.length;
    const enrolledCoursesData = filteredCourses.map((e) => e.toObject());

    // Get selected teacher info
    const selectedTeacher = teacherFilter && teacherFilter !== 'all'
      ? availableTeachers.find((t) => t._id.toString() === teacherFilter)
      : null;

    res.render('student/enrolled-courses', {
      title: selectedTeacher
        ? `${selectedTeacher.firstName} ${selectedTeacher.lastName} - My Weeks | ELKABLY`
        : 'My Enrolled Weeks | ELKABLY',
      student,
      enrolledCourses: enrolledCoursesData,
      totalCourses: totalCourses,
      availableTeachers,
      selectedTeacherId: teacherFilter,
      selectedTeacher,
      filters: {
        search: searchQuery,
        progress: progressFilter,
        teacher: teacherFilter,
        sort: sortBy,
      },
      pagination: {
        currentPage: 1,
        totalPages: 1,
        totalCourses: totalCourses,
        hasNext: false,
        hasPrev: false,
        nextPage: 1,
        prevPage: 1,
      },
      theme: req.cookies.theme || student.preferences?.theme || 'light',
    });
  } catch (error) {
    console.error('Enrolled courses error:', error);
    req.flash('error_msg', 'Error loading enrolled courses');
    res.redirect('/student/dashboard');
  }
};

// Course Details - View specific course details and progress
const courseDetails = async (req, res) => {
  try {
    const studentId = req.session.user.id;
    const courseId = req.params.id;

    const student = await User.findById(studentId);
    const enrollment = student.enrolledCourses.find(
      (e) => e.course.toString() === courseId
    );

    if (!enrollment) {
      req.flash('error_msg', 'You are not enrolled in this course');
      return res.redirect('/student/enrolled-courses');
    }

    const course = await Course.findById(courseId)
      .populate('topics');

    if (!course) {
      req.flash('error_msg', 'Course not found');
      return res.redirect('/student/enrolled-courses');
    }

    // Get course progress
    const courseProgress = await Progress.find({
      student: studentId,
      course: courseId,
    }).sort({ timestamp: -1 });

    // Calculate topic progress based on actual completion percentages
    const topicsWithProgress = course.topics.map((topic) => {
      const topicProgress = student.calculateTopicProgress(
        courseId,
        topic._id,
        topic.content?.length ?? 0
      );
      return {
        ...topic.toObject(),
        completed: enrollment.completedTopics.includes(topic._id),
        progress: topicProgress,
      };
    });

    res.render('student/course-details', {
      title: `${course.title} - Course Details | ELKABLY`,
      student,
      course,
      enrollment,
      topicsWithProgress,
      courseProgress,
      theme: req.cookies.theme || student.preferences?.theme || 'light',
    });
  } catch (error) {
    console.error('Course details error:', error);
    req.flash('error_msg', 'Error loading course details');
    res.redirect('/student/enrolled-courses');
  }
};

// Helper function to get content type icons
const getContentIcon = (type) => {
  const icons = {
    video: 'play-circle',
    pdf: 'file-pdf',
    assignment: 'clipboard-list',
    reading: 'book-open',
    link: 'external-link-alt',
    zoom: 'video',
  };
  return icons[type] || 'file';
};

// Course Content - View course content with topics and prerequisites
const courseContent = async (req, res) => {
  try {
    const studentId = req.session.user.id;
    const courseId = req.params.id;

    const student = await User.findById(studentId).populate({
      path: 'enrolledCourses.course',
      populate: {
        path: 'teacher',
        select: 'firstName lastName teacherCode profilePicture subject',
        model: 'Teacher',
      },
    });

    const enrollment = student.enrolledCourses.find(
      (e) => e.course && e.course._id.toString() === courseId
    );

    if (!enrollment) {
      req.flash('error_msg', 'You are not enrolled in this course');
      return res.redirect('/student/enrolled-courses');
    }

    const course = await Course.findById(courseId)
      .populate({
        path: 'topics',
        options: { sort: { order: 1 } },
        populate: [
          {
            path: 'content',
            model: 'ContentItem',
          },
          {
            path: 'content.zoomMeeting',
            model: 'ZoomMeeting',
          },
        ],
      })
      .populate('teacher', 'firstName lastName teacherCode profilePicture subject');

    if (!course) {
      req.flash('error_msg', 'Course not found');
      return res.redirect('/student/enrolled-courses');
    }

    // Get completed content IDs for this course
    const completedContentIds = student.getCompletedContentIds(courseId);

    // Filter out unpublished (draft) topics - only show published topics to students
    // Sort by order field to match admin view ordering
    const publishedTopics = course.topics
      .filter(topic => topic.isPublished === true)
      .sort((a, b) => (a.order || 0) - (b.order || 0));

    // Process topics with enhanced content status
    const topicsWithProgress = await Promise.all(
      publishedTopics.map(async (topic) => {
        const topicCompleted = enrollment.completedTopics.includes(topic._id);

        // Process content items (exclude quiz/homework - removed)
        const contentItems = (topic.content || []).filter(
          (ci) => ci.type !== 'quiz' && ci.type !== 'homework'
        );

        // Calculate topic progress based on filtered content
        const topicProgress = student.calculateTopicProgress(
          courseId,
          topic._id,
          contentItems.length
        );
        const contentWithStatus = await Promise.all(
          contentItems.map(async (contentItem, index) => {
            const isCompleted = completedContentIds.includes(
              contentItem._id.toString()
            );
            const unlockStatus = await student.isContentUnlocked(
              courseId,
              contentItem._id,
              contentItem
            );

            // Get content progress details for more accurate completion status
            const contentProgressDetails = student.getContentProgressDetails(
              courseId,
              contentItem._id
            );
            const actualProgress = contentProgressDetails
              ? contentProgressDetails.progressPercentage
              : 0;

            // Get watch count for video content
            const watchCount = contentProgressDetails?.watchCount || 0;

            // Get prerequisite names and IDs for better user experience
            let prerequisiteNames = [];
            let prerequisiteData = [];
            if (
              contentItem.prerequisites &&
              contentItem.prerequisites.length > 0
            ) {
              // Find prerequisite content names and IDs
              const allContent = course.topics.flatMap((t) => t.content || []);
              prerequisiteData = contentItem.prerequisites.map((prereqId) => {
                const prereqContent = allContent.find(
                  (c) => c._id.toString() === prereqId.toString()
                );
                return {
                  id: prereqId.toString(),
                  title: prereqContent ? prereqContent.title : 'Unknown Content',
                };
              });
              prerequisiteNames = prerequisiteData.map((p) => p.title);
            }

            return {
              ...contentItem.toObject(),
              isUnlocked: unlockStatus.unlocked,
              isCompleted: isCompleted,
              actualProgress: actualProgress,
              watchCount: watchCount,
              unlockReason: unlockStatus.reason,
              canAccess: unlockStatus.unlocked || isCompleted,
              prerequisiteNames: prerequisiteNames,
              prerequisiteData: prerequisiteData,
              contentIndex: index,
              topicId: topic._id,
            };
          })
        );

        return {
          ...topic.toObject(),
          content: contentWithStatus,
          completed: topicCompleted,
          progress: topicProgress,
        };
      })
    );

    // Get locked content ID from query parameter (if redirected from locked content)
    const lockedContentId = req.query.lockedContent || null;

    // Extract unique teachers from enrolled courses for the header
    const teachersMap = new Map();
    student.enrolledCourses.forEach((enroll) => {
      if (enroll.course && enroll.course.teacher) {
        const teacher = enroll.course.teacher;
        if (!teachersMap.has(teacher._id.toString())) {
          const teacherCourses = student.enrolledCourses.filter(
            (e) => e.course && e.course.teacher && e.course.teacher._id.toString() === teacher._id.toString()
          );
          teachersMap.set(teacher._id.toString(), {
            _id: teacher._id,
            firstName: teacher.firstName,
            lastName: teacher.lastName,
            teacherCode: teacher.teacherCode,
            profilePicture: teacher.profilePicture,
            subject: teacher.subject,
            courseCount: teacherCourses.length,
          });
        }
      }
    });
    const availableTeachers = Array.from(teachersMap.values());

    // Get current course's teacher ID for selection
    const selectedTeacherId = course.teacher ? course.teacher._id.toString() : 'all';

    res.render('student/course-content', {
      title: `${course.title} - Course Content | ELKABLY`,
      student,
      course,
      enrollment,
      topicsWithProgress,
      lockedContentId, // Pass locked content ID to highlight it
      user: req.session.user, // Pass user session for admin checks
      getContentIcon, // Pass the helper function to the template
      availableTeachers,
      selectedTeacherId,
      theme: req.cookies.theme || student.preferences?.theme || 'light',
    });
  } catch (error) {
    console.error('Course content error:', error);
    req.flash('error_msg', 'Error loading course content');
    res.redirect('/student/enrolled-courses');
  }
};

// Content Details - View specific content item
const contentDetails = async (req, res) => {
  try {
    const studentId = req.session.user.id;
    const contentId = req.params.id;

    const student = await User.findById(studentId);

    // Find the content across all enrolled courses
    let contentItem = null;
    let course = null;
    let topic = null;

    for (const enrollment of student.enrolledCourses) {
      const courseData = await Course.findById(enrollment.course).populate({
        path: 'topics',
        populate: [
          {
            path: 'content',
            model: 'ContentItem',
          },
          {
            path: 'content.zoomMeeting',
            model: 'ZoomMeeting',
          },
        ],
      });

      if (courseData) {
        for (const topicData of courseData.topics) {
          const foundContent = topicData.content.find(
            (c) => c._id.toString() === contentId
          );
          if (foundContent) {
            contentItem = foundContent;
            course = courseData;
            topic = topicData;
            break;
          }
        }
        if (contentItem) break;
      }
    }

    if (!contentItem) {
      req.flash(
        'error_msg',
        'Content not found or you are not enrolled in this course'
      );
      return res.redirect('/student/enrolled-courses');
    }

    if (contentItem.type === 'quiz' || contentItem.type === 'homework') {
      req.flash('info_msg', 'Quiz and homework content have been removed.');
      return res.redirect(`/student/course/${course._id}/content`);
    }

    // Check if content is unlocked
    const unlockStatus = await student.isContentUnlocked(
      course._id,
      contentId,
      contentItem
    );
    if (!unlockStatus.unlocked) {
      req.flash('error_msg', `Content is locked: ${unlockStatus.reason}`);
      return res.redirect(`/student/course/${course._id}/content?lockedContent=${contentId}`);
    }

    // Get content progress with detailed data
    const contentProgress = student.getContentProgressDetails(
      course._id,
      contentId
    );

    // Special handling for Zoom content completion
    let isCompleted = contentProgress
      ? contentProgress.completionStatus === 'completed'
      : false;

    // Track if student attended the live Zoom meeting (for recording restriction logic)
    let studentAttendedLiveMeeting = false;

    // For Zoom content, check if student attended live OR watched recording
    if (contentItem.type === 'zoom' && contentItem.zoomMeeting) {
      const zoomMeeting = contentItem.zoomMeeting;
      const studentIdStr = studentId.toString();

      // Check if student attended the live session
      studentAttendedLiveMeeting =
        zoomMeeting.studentsAttended &&
        zoomMeeting.studentsAttended.some(
          (attendance) => attendance.student.toString() === studentIdStr
        );

      // Check if student watched the recording
      const watchedRecording =
        zoomMeeting.studentsWatchedRecording &&
        zoomMeeting.studentsWatchedRecording.some(
          (record) =>
            record.student.toString() === studentIdStr &&
            record.completedWatching
        );

      // If student attended live, auto-mark as completed and save to DB
      if (studentAttendedLiveMeeting && !isCompleted) {
        isCompleted = true;
        // Auto-save progress to database for students who attended live
        try {
          const enrollment = student.enrolledCourses.find(
            (e) => e.course.toString() === course._id.toString()
          );
          if (enrollment) {
            await student.updateContentProgress(
              course._id,
              topic._id,
              contentId,
              'zoom',
              {
                completionStatus: 'completed',
                progressPercentage: 100,
                lastAccessed: new Date(),
                completedAt: new Date(),
              }
            );
          }
        } catch (autoCompleteError) {
          console.error('Auto-complete error for Zoom attendee:', autoCompleteError);
        }
      } else if (watchedRecording && !isCompleted) {
        // If student watched recording, mark as completed
        isCompleted = true;
      }

    }

    // AUTO-COMPLETE for PDF, reading, link, assignment content on page load
    if (!isCompleted && ['pdf', 'reading', 'link', 'assignment'].includes(contentItem.type)) {
      isCompleted = true;
      // Auto-save progress to database
      try {
        const enrollment = student.enrolledCourses.find(
          (e) => e.course.toString() === course._id.toString()
        );
        if (enrollment) {
          await student.updateContentProgress(
            course._id,
            topic._id,
            contentId,
            contentItem.type,
            {
              completionStatus: 'completed',
              progressPercentage: 100,
              lastAccessed: new Date(),
              completedAt: new Date(),
            }
          );
        }
      } catch (autoCompleteError) {
        console.error('Auto-complete error for content:', autoCompleteError);
      }
    }


    const progressPercentage = contentProgress
      ? contentProgress.progressPercentage || 0
      : 0;

    // Get quiz attempts if it's a quiz/homework content
    let attempts = 0;
    let bestScore = 0;
    let attemptsList = [];
    if (contentProgress && contentProgress.quizAttempts) {
      attempts = contentProgress.quizAttempts.length;
      bestScore = contentProgress.bestScore || 0;
      attemptsList = contentProgress.quizAttempts;
    } else if (contentProgress) {
      attempts = contentProgress.attempts || 0;
      bestScore = contentProgress.bestScore || 0;
    }

    // Get navigation data (previous and next content; exclude quiz/homework)
    const allContent = course.topics.flatMap((t) =>
      (t.content || [])
        .filter((c) => c.type !== 'quiz' && c.type !== 'homework')
        .map((c) => ({ ...c.toObject(), topicId: t._id }))
    );
    const currentIndex = allContent.findIndex(
      (c) => c._id.toString() === contentId
    );

    let previousContent = null;
    let nextContent = null;

    if (currentIndex > 0) {
      previousContent = allContent[currentIndex - 1];
    }

    if (currentIndex < allContent.length - 1) {
      nextContent = allContent[currentIndex + 1];
    }

    // Check if next content is accessible
    let nextContentAccessible = false;
    if (nextContent) {
      // First check the unlock status
      const nextUnlockStatus = student.isContentUnlocked(
        course._id,
        nextContent._id,
        nextContent
      );
      nextContentAccessible = nextUnlockStatus.unlocked;

      // Additional check: if current content is a prerequisite and is Zoom content
      // Make sure it's marked as completed if student attended OR watched recording
      if (
        !nextContentAccessible &&
        contentItem.type === 'zoom' &&
        isCompleted
      ) {
        // Recheck after considering Zoom completion
        const recheck = student.isContentUnlocked(
          course._id,
          nextContent._id,
          nextContent
        );
        nextContentAccessible = recheck.unlocked;
      }
    }


    let serverTiming = null;
    let attemptPolicy = null;

    // Video watch limit info
    let watchLimitInfo = null;
    if (contentItem.type === 'video') {
      const watchCount = contentProgress?.watchCount || 0;
      const maxWatchCount = contentItem.maxWatchCount;
      const hasLimit = maxWatchCount !== null && maxWatchCount !== undefined && maxWatchCount !== -1;
      const watchesLeft = hasLimit ? Math.max(0, maxWatchCount - watchCount) : null;
      const limitReached = hasLimit && watchCount >= maxWatchCount;

      watchLimitInfo = {
        watchCount: watchCount,
        maxWatchCount: maxWatchCount,
        hasLimit: hasLimit,
        watchesLeft: watchesLeft,
        limitReached: limitReached,
        canWatch: !limitReached,
      };
    }

    // Get available teachers from student's enrolled courses for header
    const studentWithTeachers = await User.findById(studentId).populate({
      path: 'enrolledCourses.course',
      populate: {
        path: 'teacher',
        select: 'firstName lastName teacherCode profilePicture subject',
        model: 'Teacher',
      },
    });

    const teachersMap = new Map();
    studentWithTeachers.enrolledCourses.forEach((enroll) => {
      if (enroll.course && enroll.course.teacher) {
        const teacher = enroll.course.teacher;
        if (!teachersMap.has(teacher._id.toString())) {
          const teacherCourses = studentWithTeachers.enrolledCourses.filter(
            (e) => e.course && e.course.teacher && e.course.teacher._id.toString() === teacher._id.toString()
          );
          teachersMap.set(teacher._id.toString(), {
            _id: teacher._id,
            firstName: teacher.firstName,
            lastName: teacher.lastName,
            teacherCode: teacher.teacherCode,
            profilePicture: teacher.profilePicture,
            subject: teacher.subject,
            courseCount: teacherCourses.length,
          });
        }
      }
    });
    const availableTeachers = Array.from(teachersMap.values());

    // Get current course's teacher ID
    const courseWithTeacher = await Course.findById(course._id).populate('teacher', 'firstName lastName');
    const selectedTeacherId = courseWithTeacher && courseWithTeacher.teacher ? courseWithTeacher.teacher._id.toString() : 'all';

    res.render('student/content-details', {
      title: `${contentItem.title} - Content | ELKABLY`,
      student,
      course,
      topic,
      contentItem,
      contentProgress: {
        isCompleted: isCompleted,
        progressPercentage: progressPercentage,
        completionStatus: contentProgress
          ? contentProgress.completionStatus
          : 'not_started',
        lastAccessed: contentProgress ? contentProgress.lastAccessed : null,
        completedAt: contentProgress ? contentProgress.completedAt : null,
        attempts: attempts,
        bestScore: bestScore,
        attemptsList: attemptsList,
      },
      timing: serverTiming,
      attemptPolicy: attemptPolicy,
      watchLimitInfo: watchLimitInfo,
      studentAttendedLiveMeeting: studentAttendedLiveMeeting, // For recording restriction logic
      requiresAcknowledgment:
        !isCompleted &&
        ['pdf', 'reading', 'link', 'assignment'].includes(contentItem.type),
      navigation: {
        previousContent: previousContent,
        nextContent: nextContent,
        nextContentAccessible: nextContentAccessible,
        currentIndex: currentIndex,
        totalContent: allContent.length,
      },
      availableTeachers,
      selectedTeacherId,
      getContentIcon, // Pass the helper function to the template
      theme: req.cookies.theme || student.preferences?.theme || 'light',
    });
  } catch (error) {
    console.error('Content details error:', error);
    req.flash('error_msg', 'Error loading content');
    res.redirect('/student/enrolled-courses');
  }
};

// Update Content Progress - AJAX endpoint to update progress
const updateContentProgress = async (req, res) => {
  try {
    const studentId = req.session.user.id;
    const { courseId, topicId, contentId, contentType, progressData } =
      req.body;


    const student = await User.findById(studentId);

    // Validate enrollment
    const enrollment = student.enrolledCourses.find(
      (e) => e.course.toString() === courseId
    );

    if (!enrollment) {
      return res.status(403).json({
        success: false,
        message: 'You are not enrolled in this course',
      });
    }

    console.log(
      'Before update - enrollment contentProgress length:',
      enrollment.contentProgress.length
    );

    // Check if this is a NEW completion BEFORE updating (to avoid duplicate notifications)
    const existingProgress = enrollment.contentProgress.find(
      (cp) => cp.contentId.toString() === contentId.toString()
    );
    const wasAlreadyCompleted = existingProgress &&
      existingProgress.completionStatus === 'completed';
    const isNewCompletion = progressData &&
      progressData.completionStatus === 'completed' &&
      !wasAlreadyCompleted;

    // Get course and topic data for notification (before update)
    let contentTitle = 'Content';
    let isZoomContent = false;
    let shouldSendNotification = false;
    let contentItem = null;

    // Fetch content item for validation
    try {
      const course = await Course.findById(courseId);
      const topic = await Topic.findById(topicId);

      if (topic && topic.content) {
        contentItem = topic.content.find(
          (c) => c._id.toString() === contentId
        );
        if (contentItem) {
          contentTitle = contentItem.title;
          isZoomContent = contentItem.type === 'zoom';
          // Only send notification if NOT zoom content (zoom meeting end sends its own SMS)
          shouldSendNotification = !isZoomContent && isNewCompletion;
        }
      }
    } catch (error) {
      console.error('Error checking content type:', error);
    }

    // VIDEO WATCH LIMIT VALIDATION
    // If this is a video content and trying to mark as completed, check watch limit
    // Check on EVERY completion attempt (not just new completions) to enforce limits
    if (contentItem && contentItem.type === 'video' && progressData && progressData.completionStatus === 'completed') {
      const maxWatchCount = contentItem.maxWatchCount;

      // If maxWatchCount is set (not null/undefined/-1), enforce the limit
      if (maxWatchCount !== null && maxWatchCount !== undefined && maxWatchCount !== -1 && maxWatchCount > 0) {
        const currentWatchCount = existingProgress?.watchCount || 0;

        // Check if student has reached the watch limit BEFORE allowing this completion
        // Since watch count will increment after this check, we check if current count >= max
        if (currentWatchCount >= maxWatchCount) {
          return res.status(403).json({
            success: false,
            message: `You have reached the maximum watch limit (${maxWatchCount} times) for this video.`,
            watchCount: currentWatchCount,
            maxWatchCount: maxWatchCount,
            limitReached: true,
          });
        }
      }

      // ==================== ANTI-SKIP VALIDATION ====================
      // Validate that student actually watched 90% of the video (not just skipped to the end)
      // NOTE: We use a slightly lower threshold (85%) on backend to account for:
      // - Mobile browser timing issues with timeupdate events
      // - Edge cases where last few seconds aren't tracked
      // - Network latency causing segment gaps
      // The frontend still enforces 90% before sending the completion request
      if (progressData.watchData) {
        const watchData = progressData.watchData;
        const REQUIRED_WATCH_PERCENTAGE = 85; // Backend threshold (frontend uses 90%)
        const FRONTEND_REPORTED_PERCENTAGE = watchData.watchPercentage || 0;

        // Backend validation: Calculate actual watched time from segments
        let totalWatchedTime = 0;

        if (watchData.watchedSegments && Array.isArray(watchData.watchedSegments)) {
          // Merge and validate segments
          const segments = watchData.watchedSegments
            .filter(seg => seg.start >= 0 && seg.end > seg.start) // Valid segments only
            .sort((a, b) => a.start - b.start);

          // Merge overlapping segments to get accurate total
          // Use larger tolerance for mobile compatibility
          const mergedSegments = [];
          for (const segment of segments) {
            if (mergedSegments.length === 0) {
              mergedSegments.push({ start: segment.start, end: segment.end });
            } else {
              const last = mergedSegments[mergedSegments.length - 1];
              if (segment.start <= last.end + 2) { // Increased tolerance from 0.5 to 2 seconds
                // Overlapping or adjacent - merge
                last.end = Math.max(last.end, segment.end);
              } else {
                // New separate segment
                mergedSegments.push({ start: segment.start, end: segment.end });
              }
            }
          }

          // Calculate total watched time
          for (const segment of mergedSegments) {
            totalWatchedTime += (segment.end - segment.start);
          }
        }

        // Validate against video duration
        const videoDuration = watchData.videoDuration || 0;

        if (videoDuration > 0) {
          const actualWatchPercentage = (totalWatchedTime / videoDuration) * 100;

          // Log for debugging
          console.log(`Video Watch Validation - Student: ${studentId}, Content: ${contentId}`);
          console.log(`  Duration: ${videoDuration}s, Watched: ${totalWatchedTime.toFixed(2)}s (${actualWatchPercentage.toFixed(2)}%)`);
          console.log(`  Frontend reported: ${FRONTEND_REPORTED_PERCENTAGE.toFixed(2)}%`);
          console.log(`  Backend threshold: ${REQUIRED_WATCH_PERCENTAGE}%, Result: ${actualWatchPercentage >= REQUIRED_WATCH_PERCENTAGE ? 'PASS' : 'FAIL'}`);

          // Accept if either:
          // 1. Backend calculation shows enough watched (85%+)
          // 2. Frontend reported 90%+ AND backend shows at least 75% (accounts for tracking gaps)
          const backendPass = actualWatchPercentage >= REQUIRED_WATCH_PERCENTAGE;
          const frontendReportedEnough = FRONTEND_REPORTED_PERCENTAGE >= 90 && actualWatchPercentage >= 75;

          if (!backendPass && !frontendReportedEnough) {
            return res.status(400).json({
              success: false,
              message: `You must watch at least 90% of the video to complete it. You have watched ${actualWatchPercentage.toFixed(1)}%. Skipping is not allowed.`,
              watchPercentage: actualWatchPercentage,
              requiredPercentage: 90,
            });
          }

          if (frontendReportedEnough && !backendPass) {
            console.log(`  NOTE: Accepted based on frontend report (mobile compatibility)`);
          }
        }
      }
    }

    // Update content progress
    await student.updateContentProgress(
      courseId,
      topicId,
      contentId,
      contentType,
      progressData
    );

    // Refresh student data to get updated progress
    const updatedStudent = await User.findById(studentId);
    const updatedEnrollment = updatedStudent.enrolledCourses.find(
      (e) => e.course.toString() === courseId
    );


    // Get updated progress
    const updatedProgress = updatedStudent.getContentProgressDetails(
      courseId,
      contentId
    );

    // Send WhatsApp notification to parent for content completion
    // Only send if this is a NEW completion (not a re-completion)
    // Skip if this is a zoom content completion (zoom meeting end will send its own detailed SMS)
    try {
      // Check if content is completed AND it's a NEW completion
      // Skip zoom content - zoom meeting end will send detailed SMS
      if (progressData && progressData.completionStatus === 'completed' && !isZoomContent && isNewCompletion) {
        // Get course and topic data for notification (only if we need to send)
        const course = await Course.findById(courseId);
        const topic = await Topic.findById(topicId);

        // Find the actual content item to get its title
        let contentTitle = 'Content';
        if (topic && topic.content) {
          const contentItem = topic.content.find(
            (c) => c._id.toString() === contentId
          );
          if (contentItem) {
            contentTitle = contentItem.title;
          }
        }

        // Send notification for NEW completion
        await whatsappSMSNotificationService.sendContentCompletionNotification(
          studentId,
          { title: contentTitle, type: contentType },
          course
        );
      }
    } catch (whatsappError) {
      console.error('WhatsApp notification error:', whatsappError);
      // Don't fail the progress update if WhatsApp fails
    }

    // Prepare response with watch count info for videos
    const response = {
      success: true,
      contentProgress: updatedProgress,
      courseProgress: updatedEnrollment.progress,
      totalContentProgress: updatedEnrollment.contentProgress.length,
      message: 'Progress updated successfully',
    };

    // Add watch count info for video content
    if (contentItem && contentItem.type === 'video') {
      const finalProgress = updatedEnrollment.contentProgress.find(
        (cp) => cp.contentId.toString() === contentId.toString()
      );
      response.watchCount = finalProgress?.watchCount || 0;
      response.maxWatchCount = contentItem.maxWatchCount;
    }

    res.json(response);
  } catch (error) {
    console.error('Update content progress error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating progress',
    });
  }
};

// Wishlist - View wishlist
const wishlist = async (req, res) => {
  try {
    const studentId = req.session.user.id;
    const page = parseInt(req.query.page) || 1;
    const limit = 12;
    const skip = (page - 1) * limit;

    const student = await User.findById(studentId);

    if (!student) {
      req.flash('error_msg', 'Student not found');
      return res.redirect('/auth/login');
    }

    // Get wishlist courses (simplified - no more bundles)
    const wishlistCourseIds = student.wishlist || [];

    // Fetch courses
    const wishlistCourses = await Course.find({
      _id: { $in: wishlistCourseIds },
    })
      .populate('teacher', 'firstName lastName teacherCode')
      .select(
        'title description shortDescription thumbnail level duration tags topics price teacher'
      );

    // All items are courses now (no bundles)
    const allItems = wishlistCourses.map((course) => ({
      ...course.toObject(),
      type: 'course',
    }));

    const totalItems = allItems.length;
    const totalPages = Math.ceil(totalItems / limit);
    const paginatedItems = allItems.slice(skip, skip + limit);

    res.render('student/wishlist', {
      title: 'My Wishlist | ELKABLY',
      student,
      wishlistCourses: paginatedItems.filter((item) => item.type === 'course'),
      pagination: {
        currentPage: page,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
        nextPage: page + 1,
        prevPage: page - 1,
      },
      theme: req.cookies.theme || student.preferences?.theme || 'light',
    });
  } catch (error) {
    console.error('Wishlist error:', error);
    req.flash('error_msg', 'Error loading wishlist');
    res.redirect('/student/dashboard');
  }
};

// Add to Wishlist
const addToWishlist = async (req, res) => {
  try {
    const studentId = req.session.user.id;
    const itemId = req.params.id;
    const itemType = req.query.type || 'course';

    const student = await User.findById(studentId);

    if (itemType === 'course') {
      await student.addCourseToWishlist(itemId);
      req.flash('success_msg', 'Course added to wishlist');
    }

    res.redirect('back');
  } catch (error) {
    console.error('Add to wishlist error:', error);
    req.flash('error_msg', 'Error adding item to wishlist');
    res.redirect('back');
  }
};

// Remove from Wishlist
const removeFromWishlist = async (req, res) => {
  try {
    const studentId = req.session.user.id;
    const itemId = req.params.id;
    const itemType = req.query.type || 'course';

    const student = await User.findById(studentId);

    if (itemType === 'course') {
      await student.removeCourseFromWishlist(itemId);
      req.flash('success_msg', 'Course removed from wishlist');
    }

    res.redirect('back');
  } catch (error) {
    console.error('Remove from wishlist error:', error);
    req.flash('error_msg', 'Error removing item from wishlist');
    res.redirect('back');
  }
};

// Order History - View purchase history
const orderHistory = async (req, res) => {
  try {
    const studentId = req.session.user.id;
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const skip = (page - 1) * limit;

    const student = await User.findById(studentId);

    if (!student) {
      req.flash('error_msg', 'Student not found');
      return res.redirect('/auth/login');
    }

    // Get purchase history
    const purchaseHistory = student.purchasedCourses || [];
    const totalOrders = purchaseHistory.length;
    const totalPages = Math.ceil(totalOrders / limit);
    const paginatedOrders = purchaseHistory.slice(skip, skip + limit);

    // Populate course details for each order (no more bundles)
    const populatedOrders = await Promise.all(
      paginatedOrders.map(async (order) => {
        const course = await Course.findById(order.course)
          .populate('teacher', 'firstName lastName teacherCode')
          .select('title thumbnail level duration teacher');
        return { ...order.toObject ? order.toObject() : order, item: course, type: 'course' };
      })
    );

    res.render('student/order-history', {
      title: 'Order History | ELKABLY',
      student,
      orders: populatedOrders,
      pagination: {
        currentPage: page,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
        nextPage: page + 1,
        prevPage: page - 1,
      },
      theme: req.cookies.theme || student.preferences?.theme || 'light',
    });
  } catch (error) {
    console.error('Order history error:', error);
    req.flash('error_msg', 'Error loading order history');
    res.redirect('/student/dashboard');
  }
};

// Order Details - View specific order details
const orderDetails = async (req, res) => {
  try {
    const studentId = req.session.user.id;
    const orderNumber = req.params.orderNumber;

    const student = await User.findById(studentId);

    if (!student) {
      req.flash('error_msg', 'Student not found');
      return res.redirect('/auth/login');
    }

    // First try to find in Purchase model (new system)
    const Purchase = require('../models/Purchase');
    let order = await Purchase.findOne({
      user: studentId,
      orderNumber: orderNumber,
    })
      .populate(
        'appliedPromoCode',
        'code name description discountType discountValue'
      )
      .populate('items.item')
      .lean();

    let isNewSystem = true;

    // If not found in Purchase model, try User model (legacy system)
    if (!order) {
      isNewSystem = false;
      const purchaseHistory = student.getPurchaseHistory();
      order = purchaseHistory.find((p) => p.orderNumber === orderNumber);

      if (!order) {
        req.flash('error_msg', 'Order not found');
        return res.redirect('/student/order-history');
      }
    }

    // Populate item details - now only courses (no bundles)
    let item = null;
    let itemType = 'course';
    let courseId = null;

    if (isNewSystem) {
      // New system - use items array
      const firstItem =
        order.items && order.items.length > 0 ? order.items[0] : null;

      if (firstItem) {
        itemType = 'course';
        courseId = firstItem.item;
        item = await Course.findById(firstItem.item)
          .populate('topics', 'title description')
          .populate('teacher', 'firstName lastName teacherCode')
          .select(
            'title description shortDescription thumbnail level duration tags topics price teacher'
          );
      }
    } else {
      // Legacy system - use direct course field
      if (order.course) {
        itemType = 'course';
        courseId = order.course;
        item = await Course.findById(order.course)
          .populate('topics', 'title description')
          .populate('teacher', 'firstName lastName teacherCode')
          .select(
            'title description shortDescription thumbnail level duration tags topics price teacher'
          );
      }
    }

    // Format the order data for the template
    const formattedOrder = {
      ...order,
      item: item,
      type: itemType,
      course: courseId,
      price:
        order.price ||
        (order.items && order.items[0] ? order.items[0].price : 0),
      purchasedAt: order.purchasedAt || order.createdAt,
      // Ensure we have all necessary fields
      orderNumber: order.orderNumber,
      status: order.status || 'completed',
      total: order.total || order.price,
      subtotal: order.subtotal || order.price,
      tax: order.tax || 0,
      discountAmount: order.discountAmount || 0,
      originalAmount: order.originalAmount || order.price,
      appliedPromoCode: order.appliedPromoCode,
      promoCodeUsed: order.promoCodeUsed,
    };

    // Debug logging

    res.render('student/order-details', {
      title: `Order #${orderNumber} | ELKABLY`,
      student,
      order: formattedOrder,
      theme: req.cookies.theme || student.preferences?.theme || 'light',
    });
  } catch (error) {
    console.error('Order details error:', error);
    req.flash('error_msg', 'Error loading order details');
    res.redirect('/student/order-history');
  }
};

// My Profile - View and edit profile
const profile = async (req, res) => {
  try {
    const studentId = req.session.user.id;
    const student = await User.findById(studentId);

    if (!student) {
      req.flash('error_msg', 'Student not found');
      return res.redirect('/auth/login');
    }

    // Get achievements
    const achievements = await Progress.getStudentAchievements(studentId);

    res.render('student/profile', {
      title: 'My Profile | ELKABLY',
      student,
      achievements,
      theme: req.cookies.theme || student.preferences?.theme || 'light',
    });
  } catch (error) {
    console.error('Profile error:', error);
    req.flash('error_msg', 'Error loading profile');
    res.redirect('/student/dashboard');
  }
};

// Generate a random 6-digit OTP
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// Send OTP for profile phone number change
const sendProfileOTP = async (req, res) => {
  try {
    const { phoneNumber, countryCode } = req.body;

    if (!phoneNumber || !countryCode) {
      return res.status(400).json({
        success: false,
        message: 'Phone number and country code are required',
      });
    }

    // Validate phone number format
    const cleanPhoneNumber = phoneNumber.replace(/[^\d]/g, '');
    if (!cleanPhoneNumber || cleanPhoneNumber.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Invalid phone number format',
      });
    }

    // Rate limiting: Check OTP send attempts (3 attempts per hour)
    const attemptsKey = 'profile_otp_attempts';
    const attemptsBlockedKey = 'profile_otp_blocked_until';
    const maxAttempts = 3;
    const blockDuration = 60 * 60 * 1000; // 1 hour in milliseconds

    // Initialize attempts counter if not exists
    if (!req.session[attemptsKey]) {
      req.session[attemptsKey] = 0;
    }

    // Check if user is currently blocked
    const blockedUntil = req.session[attemptsBlockedKey];
    if (blockedUntil && Date.now() < blockedUntil) {
      const remainingMinutes = Math.ceil(
        (blockedUntil - Date.now()) / (60 * 1000)
      );
      return res.status(429).json({
        success: false,
        message: `Too many OTP requests. Please try again after ${remainingMinutes} minute(s).`,
        blockedUntil: blockedUntil,
        retryAfter: remainingMinutes,
      });
    }

    // Reset attempts if block period has passed
    if (blockedUntil && Date.now() >= blockedUntil) {
      req.session[attemptsKey] = 0;
      delete req.session[attemptsBlockedKey];
    }

    // Check if user has exceeded max attempts (check BEFORE incrementing)
    if (req.session[attemptsKey] >= maxAttempts) {
      const blockUntil = Date.now() + blockDuration;
      req.session[attemptsBlockedKey] = blockUntil;
      const remainingMinutes = Math.ceil(blockDuration / (60 * 1000));

      return res.status(429).json({
        success: false,
        message: `You have exceeded the maximum number of OTP requests (${maxAttempts}). Please try again after ${remainingMinutes} minute(s).`,
        blockedUntil: blockUntil,
        retryAfter: remainingMinutes,
      });
    }

    // Increment attempts counter (only if not blocked)
    req.session[attemptsKey] = (req.session[attemptsKey] || 0) + 1;

    // Generate OTP
    const otp = generateOTP();
    const fullPhoneNumber = countryCode + cleanPhoneNumber;

    // Store OTP in session with expiration (5 minutes)
    req.session.profile_otp = otp;
    req.session.profile_otp_expiry = Date.now() + 5 * 60 * 1000; // 5 minutes
    req.session.profile_phone_verified = false;
    req.session.profile_phone_number = fullPhoneNumber;

    // Check if country code is NOT Egyptian (+20)
    const isEgyptian = countryCode === '+20' || countryCode === '20';
    const message = `Your ELKABLY verification code is: ${otp}. Valid for 5 minutes. Do not share this code.`;

    try {
      if (isEgyptian) {
        // Send via SMS for Egyptian numbers
        const { sendSms } = require('../utils/sms');
        await sendSms({
          recipient: fullPhoneNumber,
          message: message,
        });
        console.log(`Profile OTP sent via SMS to ${fullPhoneNumber}`);
      } else {
        // Send via WhatsApp for non-Egyptian numbers
        const wasender = require('../utils/wasender');
        const SESSION_API_KEY = process.env.WASENDER_SESSION_API_KEY || process.env.WHATSAPP_SESSION_API_KEY || '';

        if (!SESSION_API_KEY) {
          throw new Error('WhatsApp session API key not configured');
        }

        // Format phone number for WhatsApp (remove + and ensure proper format)
        const cleanPhone = fullPhoneNumber.replace(/^\+/, '').replace(/\D/g, '');
        const whatsappJid = `${cleanPhone}@s.whatsapp.net`;

        const result = await wasender.sendTextMessage(SESSION_API_KEY, whatsappJid, message);

        if (!result.success) {
          // Check if the error is about JID not existing on WhatsApp
          const errorMessage = result.message || '';
          const hasJidError = errorMessage.toLowerCase().includes('jid does not exist') ||
            errorMessage.toLowerCase().includes('does not exist on whatsapp') ||
            (result.errors && result.errors.to &&
              result.errors.to.some(err => err.toLowerCase().includes('does not exist')));

          if (hasJidError) {
            throw new Error('This phone number does not have WhatsApp or WhatsApp is not available for this number. Please use an Egyptian phone number (+20) to receive OTP via SMS, or ensure your phone number is registered on WhatsApp.');
          }

          throw new Error(result.message || 'Failed to send WhatsApp message');
        }

        console.log(`Profile OTP sent via WhatsApp to ${fullPhoneNumber}`);
      }

      return res.json({
        success: true,
        message: 'OTP sent successfully',
        expiresIn: 300, // 5 minutes in seconds
        attemptsRemaining: maxAttempts - req.session[attemptsKey],
      });
    } catch (error) {
      console.error(`${isEgyptian ? 'SMS' : 'WhatsApp'} sending error:`, error);

      // Clear session on failure
      delete req.session.profile_otp;
      delete req.session.profile_otp_expiry;

      return res.status(500).json({
        success: false,
        message: 'Failed to send OTP. Please try again.',
        error: error.message,
      });
    }
  } catch (error) {
    console.error('Send profile OTP error:', error);
    return res.status(500).json({
      success: false,
      message: 'An error occurred while sending OTP',
      error: error.message,
    });
  }
};

// Verify OTP for profile phone number change
const verifyProfileOTP = async (req, res) => {
  try {
    const { otp } = req.body;

    if (!otp) {
      return res.status(400).json({
        success: false,
        message: 'OTP is required',
      });
    }

    const storedOTP = req.session.profile_otp;
    const expiryTime = req.session.profile_otp_expiry;

    // Check if OTP exists
    if (!storedOTP || !expiryTime) {
      return res.status(400).json({
        success: false,
        message: 'OTP not found or expired. Please request a new OTP.',
      });
    }

    // Check if OTP has expired
    if (Date.now() > expiryTime) {
      delete req.session.profile_otp;
      delete req.session.profile_otp_expiry;
      return res.status(400).json({
        success: false,
        message: 'OTP has expired. Please request a new OTP.',
      });
    }

    // Verify OTP
    if (otp.toString() !== storedOTP.toString()) {
      return res.status(400).json({
        success: false,
        message: 'Invalid OTP. Please try again.',
      });
    }

    // Mark phone as verified
    req.session.profile_phone_verified = true;

    // Clear OTP from session (one-time use)
    delete req.session.profile_otp;
    delete req.session.profile_otp_expiry;

    // Reset OTP attempts counter on successful verification
    delete req.session.profile_otp_attempts;
    delete req.session.profile_otp_blocked_until;

    return res.json({
      success: true,
      message: 'OTP verified successfully',
    });
  } catch (error) {
    console.error('Verify profile OTP error:', error);
    return res.status(500).json({
      success: false,
      message: 'An error occurred while verifying OTP',
      error: error.message,
    });
  }
};

// Update Profile
const updateProfile = async (req, res) => {
  try {
    const studentId = req.session.user.id;
    const updates = req.body;

    // Get current student data to compare phone numbers
    const currentStudent = await User.findById(studentId);
    if (!currentStudent) {
      return res.status(404).json({
        success: false,
        message: 'Student not found',
      });
    }

    // Remove sensitive fields that shouldn't be updated directly
    delete updates.password;
    delete updates.role;
    delete updates.isActive;
    delete updates.studentCode;
    delete updates.email; // Email should not be editable
    delete updates.username; // Username should not be editable

    // Block phone number changes - students cannot change their phone numbers
    delete updates.studentNumber;
    delete updates.parentNumber;
    delete updates.studentCountryCode;
    delete updates.parentCountryCode;

    // Only allow specific fields to be updated
    const allowedFields = [
      'firstName',
      'lastName',
      'schoolName',
      'grade',
    ];
    const filteredUpdates = {};

    allowedFields.forEach((field) => {
      if (updates[field] !== undefined) {
        filteredUpdates[field] = updates[field];
      }
    });

    // Validate required fields
    if (
      filteredUpdates.firstName &&
      filteredUpdates.firstName.trim().length < 2
    ) {
      return res.status(400).json({
        success: false,
        message: 'First name must be at least 2 characters long',
      });
    }

    if (
      filteredUpdates.lastName &&
      filteredUpdates.lastName.trim().length < 2
    ) {
      return res.status(400).json({
        success: false,
        message: 'Last name must be at least 2 characters long',
      });
    }


    const student = await User.findByIdAndUpdate(studentId, filteredUpdates, {
      new: true,
      runValidators: true,
    });

    if (!student) {
      return res.status(404).json({
        success: false,
        message: 'Student not found',
      });
    }

    res.json({
      success: true,
      message: 'Profile updated successfully',
      student: {
        name: student.name,
        firstName: student.firstName,
        lastName: student.lastName,
        schoolName: student.schoolName,
        grade: student.grade,
        studentNumber: student.studentNumber,
        parentNumber: student.parentNumber,
        studentCountryCode: student.studentCountryCode,
        parentCountryCode: student.parentCountryCode,
      },
    });
  } catch (error) {
    console.error('Update profile error:', error);

    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map((err) => err.message);
      return res.status(400).json({
        success: false,
        message: messages.join(', '),
      });
    }

    res.status(500).json({
      success: false,
      message: 'Error updating profile',
    });
  }
};

// Settings - View settings
const settings = async (req, res) => {
  try {
    const studentId = req.session.user.id;
    const student = await User.findById(studentId);

    if (!student) {
      req.flash('error_msg', 'Student not found');
      return res.redirect('/auth/login');
    }

    res.render('student/settings', {
      title: 'Settings | ELKABLY',
      student,
      theme: req.cookies.theme || student.preferences?.theme || 'light',
    });
  } catch (error) {
    console.error('Settings error:', error);
    req.flash('error_msg', 'Error loading settings');
    res.redirect('/student/dashboard');
  }
};

// Update Settings
const updateSettings = async (req, res) => {
  try {
    const studentId = req.session.user.id;
    const { theme, notifications, language } = req.body;

    const student = await User.findById(studentId);

    // Update preferences
    const updatedPreferences = { ...student.preferences };

    if (theme) {
      updatedPreferences.theme = theme;
    }

    if (notifications) {
      updatedPreferences.notifications = {
        ...updatedPreferences.notifications,
        ...notifications,
      };
    }

    if (language) {
      updatedPreferences.language = language;
    }

    student.preferences = updatedPreferences;
    await student.save();

    // Update session theme if theme was changed
    if (theme) {
      req.session.user.preferences = student.preferences;

      // Set theme cookie
      res.cookie('theme', theme, {
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        httpOnly: false,
      });
    }

    res.json({
      success: true,
      message: 'Settings updated successfully',
      preferences: student.preferences,
    });
  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating settings',
    });
  }
};

// Update Profile Picture
const updateProfilePicture = async (req, res) => {
  try {
    const studentId = req.session.user.id;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No image file provided',
      });
    }

    const student = await User.findById(studentId);
    if (!student) {
      return res.status(404).json({
        success: false,
        message: 'Student not found',
      });
    }

    // Upload image (uses local storage by default)
    const { uploadImage, deleteImage } = require('../utils/cloudinary');
    const uploadResult = await uploadImage(req.file.buffer, {
      folder: 'profile-pictures',
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
    });

    // Delete old profile picture if it exists (handles both Cloudinary and local)
    if (student.profilePicture) {
      try {
        // deleteImage now handles both Cloudinary URLs and local paths
        await deleteImage(student.profilePicture);
      } catch (deleteError) {
        console.error('Error deleting old profile picture:', deleteError);
        // Continue even if deletion fails
      }
    }

    // Update profile picture URL
    student.profilePicture = uploadResult.url;
    await student.save();

    res.json({
      success: true,
      message: 'Profile picture updated successfully',
      profilePicture: student.profilePicture,
    });
  } catch (error) {
    console.error('Update profile picture error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating profile picture',
    });
  }
};

// Change Password
const changePassword = async (req, res) => {
  try {
    const studentId = req.session.user.id;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Current password and new password are required',
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 6 characters long',
      });
    }

    const student = await User.findById(studentId);
    if (!student) {
      return res.status(404).json({
        success: false,
        message: 'Student not found',
      });
    }

    // Verify current password
    const isMatch = await student.matchPassword(currentPassword);

    if (!isMatch) {
      return res.status(400).json({
        success: false,
        message: 'Current password is incorrect',
      });
    }

    // Update password
    student.password = newPassword;
    await student.save();

    res.json({
      success: true,
      message: 'Password changed successfully',
    });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({
      success: false,
      message: 'Error changing password',
    });
  }
};

// Export Data
const exportData = async (req, res) => {
  try {
    const studentId = req.session.user.id;

    const student = await User.findById(studentId)
      .populate('enrolledCourses.course')
      .populate('purchasedCourses.course');

    if (!student) {
      return res.status(404).json({
        success: false,
        message: 'Student not found',
      });
    }

    // Prepare data for export
    const exportData = {
      studentInfo: {
        name: student.name,
        email: student.studentEmail,
        username: student.username,
        studentCode: student.studentCode,
        grade: student.grade,
        schoolName: student.schoolName,
        joinedAt: student.createdAt,
      },
      learningProgress: {
        enrolledCourses: student.enrolledCourses.map((enrollment) => ({
          courseName: enrollment.course?.name || 'Unknown Course',
          progress: enrollment.progress,
          status: enrollment.status,
          enrolledAt: enrollment.enrolledAt,
          lastAccessed: enrollment.lastAccessed,
          completedTopics: enrollment.completedTopics.length,
        })),
        completedCourses: student.completedCourses,
        totalQuizAttempts: student.totalQuizAttempts,
        averageQuizScore: student.averageQuizScore,
      },
      purchases: {
        courses: student.purchasedCourses.map((purchase) => ({
          courseName: purchase.course?.name || 'Unknown Course',
          price: purchase.price,
          orderNumber: purchase.orderNumber,
          purchasedAt: purchase.purchasedAt,
          status: purchase.status,
        })),
      },
      preferences: student.preferences,
      exportedAt: new Date().toISOString(),
    };

    // Set headers for file download
    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="elkably-learning-data-${student.studentCode}-${new Date().toISOString().split('T')[0]
      }.json"`
    );

    res.json(exportData);
  } catch (error) {
    console.error('Export data error:', error);
    res.status(500).json({
      success: false,
      message: 'Error exporting data',
    });
  }
};

// Delete Account
const deleteAccount = async (req, res) => {
  try {
    // Account deletion is currently blocked
    return res.status(403).json({
      success: false,
      message: 'Account deletion is temporarily disabled. Please contact support if you need assistance.',
    });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting account',
    });
  }
};

// ==================== ZOOM MEETING FUNCTIONALITY ====================

/**
 * Join Zoom meeting - Redirect to external Zoom client with tracking
 */
const joinZoomMeeting = async (req, res) => {
  try {
    const { meetingId } = req.params;
    const studentId = req.session.user.id;


    // Find the Zoom meeting
    const zoomMeeting = await ZoomMeeting.findById(meetingId)
      .populate('topic', 'title')
      .populate('course', 'title');

    if (!zoomMeeting) {
      return res.status(404).json({
        success: false,
        message: 'Zoom meeting not found',
      });
    }


    // Validate meeting exists in Zoom (optional but recommended)
    try {
      const zoomMeetingDetails = await zoomService.getMeetingDetails(
        zoomMeeting.meetingId
      );
    } catch (zoomError) {
      // Continue anyway - might be a permissions issue
    }

    // Check if meeting is available (started)
    if (zoomMeeting.status === 'scheduled') {
      return res.status(403).json({
        success: false,
        message:
          'This meeting has not started yet. Please wait for the instructor to start the meeting.',
        scheduledTime: zoomMeeting.scheduledStartTime,
      });
    }

    if (zoomMeeting.status === 'ended') {
      return res.status(403).json({
        success: false,
        message: 'This meeting has ended.',
        recordingUrl: zoomMeeting.recordingUrl,
      });
    }

    // Get student information with populated enrolled courses
    const student = await User.findById(studentId).populate(
      'enrolledCourses.course'
    );

    if (!student) {
      return res.status(404).json({
        success: false,
        message: 'Student not found',
      });
    }

    // Check if student is enrolled in the course (with debug mode)
    const isEnrolled = student.enrolledCourses.some(
      (enrollment) =>
        enrollment.course &&
        enrollment.course._id.toString() === zoomMeeting.course._id.toString()
    );


    // For development/testing, you can temporarily disable this check
    const skipEnrollmentCheck =
      process.env.NODE_ENV === 'development' &&
      process.env.SKIP_ENROLLMENT_CHECK === 'true';

    if (!isEnrolled && !skipEnrollmentCheck) {
      return res.status(403).json({
        success: false,
        message: 'You are not enrolled in this course.',
        debug: {
          meetingCourse: zoomMeeting.course._id.toString(),
          studentCourses: student.enrolledCourses.map((e) =>
            e.course ? e.course._id.toString() : 'null'
          ),
          suggestion: 'Add SKIP_ENROLLMENT_CHECK=true to .env for testing',
        },
      });
    }

    // Record join attempt in our database (webhook will handle actual join/leave events)
    await zoomService.recordAttendance(
      zoomMeeting.meetingId,
      studentId,
      'join_attempt'
    );

    // Auto-mark content as completed when student joins live session
    // This ensures progress is updated immediately when they join
    try {
      const courseId = zoomMeeting.course._id || zoomMeeting.course;
      const topicId = zoomMeeting.topic._id || zoomMeeting.topic;
      const Topic = require('../models/Topic');
      const topic = await Topic.findById(topicId);

      if (topic && topic.content) {
        const zoomContentItem = topic.content.find(
          (item) => item.type === 'zoom' &&
            item.zoomMeeting &&
            item.zoomMeeting.toString() === zoomMeeting._id.toString()
        );

        if (zoomContentItem) {
          // Refresh student to get latest data before updating
          const freshStudent = await User.findById(studentId);

          // Check if already completed to avoid duplicate updates
          const existingProgress = freshStudent.enrolledCourses
            .find(e => e.course.toString() === courseId.toString())
            ?.contentProgress
            ?.find(cp => cp.contentId.toString() === zoomContentItem._id.toString());

          if (!existingProgress || existingProgress.completionStatus !== 'completed') {
            // Update content progress to mark as completed
            await freshStudent.updateContentProgress(
              courseId,
              topicId,
              zoomContentItem._id,
              'zoom',
              {
                completionStatus: 'completed',
                progressPercentage: 100,
                lastAccessed: new Date(),
                completedAt: new Date()
              }
            );
          }
        }
      }
    } catch (progressError) {
      // Don't fail the request if progress update fails
    }

    // Generate tracking join URL for external Zoom client
    // Format name as Firstname_SecondName(studentCode)
    const studentInfo = {
      name: student.name || `${student.firstName} ${student.lastName}`.trim(),
      firstName: student.firstName || '',
      lastName: student.lastName || '',
      email: student.studentEmail || student.email,
      id: student.studentCode || studentId, // Use studentCode instead of _id
      studentCode: student.studentCode || studentId.toString(), // Ensure studentCode is available
    };

    const trackingJoinUrl = zoomService.generateTrackingJoinUrl(
      zoomMeeting.meetingId,
      studentInfo,
      zoomMeeting.password
    );


    // Return join URL for external redirect
    res.json({
      success: true,
      meeting: {
        meetingId: zoomMeeting.meetingId,
        meetingName: zoomMeeting.meetingName,
        meetingTopic: zoomMeeting.meetingTopic,
        joinUrl: trackingJoinUrl, // Direct Zoom join URL
        originalJoinUrl: zoomMeeting.joinUrl, // Fallback URL
        password: zoomMeeting.password,
        startTime: zoomMeeting.scheduledStartTime,
        course: zoomMeeting.course,
        topic: zoomMeeting.topic,
      },
      student: {
        name: studentInfo.name,
        email: studentInfo.email,
      },
      joinMethod: 'external_redirect',
    });
  } catch (error) {
    console.error('❌ Error joining Zoom meeting:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to join Zoom meeting',
    });
  }
};

/**
 * Leave Zoom meeting - Update attendance record
 */
const leaveZoomMeeting = async (req, res) => {
  try {
    const { meetingId } = req.params;
    const studentId = req.session.user.id;

    console.log('Student leaving Zoom meeting:', meetingId);

    const zoomMeeting = await ZoomMeeting.findById(meetingId);

    if (!zoomMeeting) {
      return res.status(404).json({
        success: false,
        message: 'Zoom meeting not found',
      });
    }

    // Record leave event (manual tracking as backup)
    await zoomService.recordAttendance(
      zoomMeeting.meetingId,
      studentId,
      'leave'
    );

    res.json({
      success: true,
      message: 'Successfully recorded your participation',
    });
  } catch (error) {
    console.error('❌ Error leaving Zoom meeting:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to record meeting leave',
    });
  }
};

/**
 * Get student's Zoom meeting attendance history
 */
const getZoomMeetingHistory = async (req, res) => {
  try {
    const studentId = req.session.user.id;

    console.log('Getting Zoom meeting history for student:', studentId);

    // Find all meetings where student attended
    const meetings = await ZoomMeeting.find({
      'studentsAttended.student': studentId,
    })
      .populate('course', 'title thumbnail')
      .populate('topic', 'title')
      .sort({ scheduledStartTime: -1 });

    // Extract student's attendance data from each meeting
    const attendanceHistory = meetings.map((meeting) => {
      const studentAttendance = meeting.studentsAttended.find(
        (att) => att.student.toString() === studentId
      );

      return {
        meeting: {
          id: meeting._id,
          name: meeting.meetingName,
          topic: meeting.topic,
          course: meeting.course,
          scheduledStart: meeting.scheduledStartTime,
          actualStart: meeting.actualStartTime,
          actualEnd: meeting.actualEndTime,
          duration: meeting.actualDuration || meeting.duration,
          status: meeting.status,
          recordingUrl: meeting.recordingUrl,
        },
        attendance: {
          totalTimeSpent: studentAttendance?.totalTimeSpent || 0,
          attendancePercentage: studentAttendance?.attendancePercentage || 0,
          firstJoin: studentAttendance?.firstJoinTime,
          lastLeave: studentAttendance?.lastLeaveTime,
          joinCount: studentAttendance?.joinEvents.length || 0,
        },
      };
    });

    res.json({
      success: true,
      history: attendanceHistory,
    });
  } catch (error) {
    console.error('❌ Error getting meeting history:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to get meeting history',
    });
  }
};

module.exports = {
  dashboard,
  enrolledCourses,
  courseDetails,
  courseContent,
  contentDetails,
  updateContentProgress,
  wishlist,
  addToWishlist,
  removeFromWishlist,
  orderHistory,
  orderDetails,
  profile,
  updateProfile,
  sendProfileOTP,
  verifyProfileOTP,
  settings,
  updateSettings,
  // New profile and settings functions
  updateProfilePicture,
  changePassword,
  exportData,
  deleteAccount,
  // Zoom Meeting functions
  joinZoomMeeting,
  leaveZoomMeeting,
  getZoomMeetingHistory,
};
