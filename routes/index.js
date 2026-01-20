const express = require('express');
const router = express.Router();
const { isAuthenticated } = require('../middlewares/auth');
const {
  getLandingPage,
  getOnlineCourses,
  getOngroundCourses,
  getRecordedCourses,
  getRecoveryCourses,
  getCourseContent,
  getIGTeacherCourses
} = require('../controllers/landingController');

// Landing page route
router.get('/', getLandingPage);

// Online courses page route
router.get('/courses/online', getOnlineCourses);

// On-ground courses page route
router.get('/courses/onground', getOngroundCourses);

// Recorded courses page route
router.get('/courses/recorded', getRecordedCourses);

// Recovery courses page route
router.get('/courses/recovery', getRecoveryCourses);

// Course details route
router.get('/course/:id', getCourseContent);

// Legacy bundle route - redirect to course
router.get('/bundle/:id', (req, res) => res.redirect(`/course/${req.params.id}`));

// Course content route
router.get('/course/:id/content', getCourseContent);

// IG Teacher Courses route
router.get('/ig/teacher/:teacherId', getIGTeacherCourses);

// Terms of Service route
router.get('/terms-of-service', (req, res) => {
  res.render('terms-of-service', {
    title: 'Terms of Service - Elkably',
    theme: req.cookies.theme || 'light',
    user: req.session.user || null
  });
});

// Privacy Policy route
router.get('/privacy-policy', (req, res) => {
  res.render('privacy-policy', {
    title: 'Privacy Policy - Elkably',
    theme: req.cookies.theme || 'light',
    user: req.session.user || null
  });
});

// Dashboard route (protected) - Redirect based on user role
router.get('/dashboard', isAuthenticated, (req, res) => {
  if (req.session.user.role === 'admin') {
    return res.redirect('/admin/dashboard');
  } else if (req.session.user.role === 'student') {
    return res.redirect('/student/dashboard');
  }
  // Default fallback
  res.redirect('/auth/login');
});

// Theme toggle endpoint
router.post('/toggle-theme', (req, res) => {
  const currentTheme = req.cookies.theme || 'light';
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';

  res.cookie('theme', newTheme, { maxAge: 365 * 24 * 60 * 60 * 1000 }); // 1 year
  res.json({ theme: newTheme });
});

module.exports = router;

