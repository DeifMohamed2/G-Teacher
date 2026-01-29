const express = require('express');
const router = express.Router();
const { isAuthenticated } = require('../middlewares/auth');
const {
  getLandingPage,
  getIGTeacherCourses,
  getTeachersBySubject,
  getSubjectsByExamPeriod
} = require('../controllers/landingController');

// Landing page route
router.get('/', getLandingPage);

// IG Teacher Courses route
router.get('/ig/teacher/:teacherId', getIGTeacherCourses);

// API routes for dynamic data fetching
router.get('/api/teachers-by-subject', getTeachersBySubject);
router.get('/api/subjects-by-period', getSubjectsByExamPeriod);

// Terms of Service route
router.get('/terms-of-service', (req, res) => {
  res.render('terms-of-service', {
    title: 'Terms of Service - G-Teacher',
    theme: req.cookies.theme || 'light',
    user: req.session.user || null
  });
});

// Privacy Policy route
router.get('/privacy-policy', (req, res) => {
  res.render('privacy-policy', {
    title: 'Privacy Policy - G-Teacher',
    theme: req.cookies.theme || 'light',
    user: req.session.user || null
  });
});

// Refund Policy route
router.get('/refund-policy', (req, res) => {
  res.render('refund-policy', {
    title: 'Refund Policy - G-Teacher',
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

