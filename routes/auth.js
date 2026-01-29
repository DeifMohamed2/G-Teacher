const express = require('express');
const router = express.Router();
const { isNotAuthenticated, isAuthenticated } = require('../middlewares/auth');
const { 
  getLoginPage, 
  getRegisterPage, 
  registerUser, 
  loginUser, 
  logoutUser,
  getCreateAdminPage,
  createAdmin,
  sendOTP,
  verifyOTP,
  getForgotPasswordPage,
  initiateForgotPassword,
  sendForgotPasswordOTP,
  verifyForgotPasswordOTP,
  resetPassword,
} = require('../controllers/authController');

// Login page
router.get('/login', isNotAuthenticated, getLoginPage);
// Login submit
router.post('/login', loginUser);

// Register page
router.get('/register', isNotAuthenticated, getRegisterPage);
// Register submit
router.post('/register', registerUser);

// OTP routes (allow both authenticated and unauthenticated users)
router.post('/send-otp', sendOTP);
router.post('/verify-otp', verifyOTP);

// Forgot Password page
router.get('/forgot-password', isNotAuthenticated, getForgotPasswordPage);
// Initiate forgot password (find account)
router.post('/forgot-password/initiate', initiateForgotPassword);
// Send OTP for forgot password
router.post('/forgot-password/send-otp', sendForgotPasswordOTP);
// Verify OTP for forgot password
router.post('/forgot-password/verify-otp', verifyForgotPasswordOTP);
// Reset password
router.post('/reset-password', resetPassword);

// Logout handle
router.get('/logout', logoutUser);

// Hidden admin creation (token-protected)
router.get('/admin/create-admin', getCreateAdminPage);
router.post('/admin/create-admin', createAdmin);

module.exports = router;
