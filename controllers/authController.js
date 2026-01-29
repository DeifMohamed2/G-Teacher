const Admin = require('../models/Admin');
const User = require('../models/User');
const axios = require('axios');
const whatsappSMSNotificationService = require('../utils/whatsappSMSNotificationService');
const crypto = require('crypto');
const { sendSms } = require('../utils/sms');
const otpMasterUtil = require('../utils/otpMasterGenerator');

// Get login page
const getLoginPage = (req, res) => {
  res.render('auth/login', {
    title: 'Login | G-Teacher',
    theme: req.cookies.theme || 'light',
  });
};

// Get register page
const getRegisterPage = (req, res) => {
  // Clear any session data on page load/refresh
  delete req.session.lastSubmissionId;

  res.render('auth/register', {
    title: 'Register | G-Teacher',
    theme: req.cookies.theme || 'light',
  });
};

// Admin create page (hidden, token-protected)
const getCreateAdminPage = (req, res) => {
  const token = req.query.token || '';
  const setupToken = process.env.ADMIN_SETUP_TOKEN || 'only-you-know-this';
  console.log(token, setupToken);
  if (token !== setupToken) {
    req.flash('error_msg', 'Unauthorized access');
    return res.redirect('/auth/login');
  }
  return res.render('admin/create-admin', {
    title: 'Create Admin | G-Teacher',
    theme: req.cookies.theme || 'light',
    token: token,
  });
};

// Create admin account (hidden, token-protected)
const createAdmin = async (req, res) => {
  const { userName, phoneNumber, password, token, email } = req.body;
  const setupToken = process.env.ADMIN_SETUP_TOKEN || 'only-you-know-this';
  let errors = [];

  if (!token || token !== setupToken) {
    errors.push({ msg: 'Unauthorized access' });
  }
  if (!userName || !phoneNumber || !password) {
    errors.push({ msg: 'Please fill in all required fields' });
  }
  const phoneRegex = /^\+?[\d\s\-\(\)]{6,20}$/;
  if (phoneNumber && !phoneRegex.test(phoneNumber)) {
    errors.push({ msg: 'Please enter a valid phone number' });
  }
  if (password && password.length < 6) {
    errors.push({ msg: 'Password must be at least 6 characters long' });
  }

  if (errors.length > 0) {
    return res.status(400).render('admin/create-admin', {
      title: 'Create Admin | G-Teacher',
      theme: req.cookies.theme || 'light',
      errors,
      userName,
      phoneNumber,
      email,
    });
  }

  try {
    const existing = await Admin.findOne({ phoneNumber: phoneNumber.trim() });
    if (existing) {
      errors.push({ msg: 'Phone number already used' });
      return res.status(400).render('admin/create-admin', {
        title: 'Create Admin | G-Teacher',
        theme: req.cookies.theme || 'light',
        errors,
        userName,
        phoneNumber,
        email,
      });
    }

    const admin = new Admin({
      userName: userName.trim(),
      phoneNumber: phoneNumber.trim(),
      // Trim password to avoid accidental leading/trailing whitespace
      password: typeof password === 'string' ? password.trim() : password,
      email: email ? email.toLowerCase().trim() : undefined,
    });
    const saved = await admin.save();

    req.session.user = {
      id: saved._id,
      name: saved.userName,
      email: saved.email,
      role: saved.role,
      isActive: saved.isActive,
      phoneNumber: saved.phoneNumber,
    };
    return res.redirect('/admin/dashboard');
  } catch (err) {
    console.error('Create admin error:', err);
    errors.push({ msg: 'An error occurred. Please try again.' });
    return res.status(500).render('admin/create-admin', {
      title: 'Create Admin | G-Teacher',
      theme: req.cookies.theme || 'light',
      errors,
      userName,
      phoneNumber,
      email,
    });
  }
};

// Generate a random 6-digit OTP
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// Send OTP to phone number
const sendOTP = async (req, res) => {
  try {
    const { phoneNumber, countryCode, type } = req.body; // type: 'student' or 'parent'

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
    const attemptsKey = `${type}_otp_attempts`;
    const attemptsBlockedKey = `${type}_otp_blocked_until`;
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
    console.log('OTP:', otp);
    const fullPhoneNumber = countryCode + cleanPhoneNumber;

    // Store OTP in session with expiration (5 minutes)
    const otpKey = `${type}_otp`;
    const otpExpiryKey = `${type}_otp_expiry`;

    req.session[otpKey] = otp;
    req.session[otpExpiryKey] = Date.now() + 5 * 60 * 1000; // 5 minutes
    req.session[`${type}_phone_verified`] = false;
    req.session[`${type}_phone_number`] = fullPhoneNumber;

    // Check if country code is NOT Egyptian (+20)
    const isEgyptian = countryCode === '+20' || countryCode === '20';
    const message = `Your G-Teacher verification code is: ${otp}. Valid for 5 minutes. Do not share this code.`;

    try {
      if (isEgyptian) {
        // Send via SMS for Egyptian numbers
        await sendSms({
          recipient: fullPhoneNumber,
          message: message,
        });
        console.log(`OTP sent via SMS to ${fullPhoneNumber} for ${type}`);
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
          const hasJidError = errorMessage.toLowerCase().includes('JID does not exist on WhatsApp') ||
            errorMessage.toLowerCase().includes('does not exist on whatsapp') ||
            (result.errors && result.errors.to &&
              result.errors.to.some(err => err.toLowerCase().includes('does not exist')));

          if (hasJidError) {
            throw new Error('This phone number does not have WhatsApp or WhatsApp is not available for this number. Please use an Egyptian phone number (+20) to receive OTP via SMS, or ensure your phone number is registered on WhatsApp.');
          }

          throw new Error(result.message || 'Failed to send WhatsApp message');
        }

        console.log(`OTP sent via WhatsApp to ${fullPhoneNumber} for ${type}`);
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
      delete req.session[otpKey];
      delete req.session[otpExpiryKey];

      return res.status(500).json({
        success: false,
        message: 'Failed to send OTP. Please try again.',
        error: error.message,
      });
    }
  } catch (error) {
    console.error('Send OTP error:', error);
    return res.status(500).json({
      success: false,
      message: 'An error occurred while sending OTP',
      error: error.message,
    });
  }
};

// Verify OTP
const verifyOTP = async (req, res) => {
  try {
    const { otp, type } = req.body; // type: 'student' or 'parent'

    if (!otp || !type) {
      return res.status(400).json({
        success: false,
        message: 'OTP and type are required',
      });
    }

    // First, check if this is a valid master OTP (for admin backup codes)
    const masterOTPResult = otpMasterUtil.validateMasterOTP(otp.toString().trim());
    if (masterOTPResult.valid) {
      // Master OTP is valid - mark phone as verified
      req.session[`${type}_phone_verified`] = true;

      // Reset OTP attempts counter on successful verification
      const attemptsKey = `${type}_otp_attempts`;
      const attemptsBlockedKey = `${type}_otp_blocked_until`;
      delete req.session[attemptsKey];
      delete req.session[attemptsBlockedKey];

      return res.json({
        success: true,
        message: 'OTP verified successfully (Master OTP)',
      });
    }

    // If not a master OTP, check session OTP
    const otpKey = `${type}_otp`;
    const otpExpiryKey = `${type}_otp_expiry`;
    const storedOTP = req.session[otpKey];
    const expiryTime = req.session[otpExpiryKey];

    // Check if OTP exists
    if (!storedOTP || !expiryTime) {
      return res.status(400).json({
        success: false,
        message: 'OTP not found or expired. Please request a new OTP.',
      });
    }

    // Check if OTP has expired
    if (Date.now() > expiryTime) {
      delete req.session[otpKey];
      delete req.session[otpExpiryKey];
      return res.status(400).json({
        success: false,
        message: 'OTP has expired. Please request a new OTP.',
      });
    }

    // Verify OTP
    if (otp.toString().trim() !== storedOTP.toString()) {
      return res.status(400).json({
        success: false,
        message: 'Invalid OTP. Please try again.',
      });
    }

    // Mark phone as verified
    req.session[`${type}_phone_verified`] = true;

    // Clear OTP from session (one-time use)
    delete req.session[otpKey];
    delete req.session[otpExpiryKey];

    // Reset OTP attempts counter on successful verification
    const attemptsKey = `${type}_otp_attempts`;
    const attemptsBlockedKey = `${type}_otp_blocked_until`;
    delete req.session[attemptsKey];
    delete req.session[attemptsBlockedKey];

    return res.json({
      success: true,
      message: 'OTP verified successfully',
    });
  } catch (error) {
    console.error('Verify OTP error:', error);
    return res.status(500).json({
      success: false,
      message: 'An error occurred while verifying OTP',
      error: error.message,
    });
  }
};

// Register user (Simplified version - only firstName, lastName, username, email, password, password2)
const registerUser = async (req, res) => {
  const {
    firstName,
    lastName,
    username,
    grade,
    curriculum,
    howDidYouKnow,
    howDidYouKnowOther,
    email,
    studentEmail,
    password,
    password2,
    termsAccepted,
    studentNumber,
    studentCountryCode,
    parentNumber,
    parentCountryCode,
  } = req.body;

  let errors = [];

  // Use studentEmail if email is not provided (for backwards compatibility)
  const userEmail = email || studentEmail;

  // Check required fields individually for better error messages
  if (!firstName || !firstName.trim()) {
    errors.push({ msg: 'First name is required', field: 'firstName' });
  }

  if (!lastName || !lastName.trim()) {
    errors.push({ msg: 'Last name is required', field: 'lastName' });
  }

  if (!username || !username.trim()) {
    errors.push({ msg: 'Username is required', field: 'username' });
  }

  if (!grade) {
    errors.push({ msg: 'Please select your year', field: 'grade' });
  }

  if (!curriculum) {
    errors.push({ msg: 'Please select your curriculum', field: 'curriculum' });
  }

  if (!userEmail || !userEmail.trim()) {
    errors.push({ msg: 'Email address is required', field: 'studentEmail' });
  }

  if (!password) {
    errors.push({ msg: 'Password is required', field: 'password' });
  }

  if (!password2) {
    errors.push({ msg: 'Please confirm your password', field: 'password2' });
  }

  if (!password2) {
    errors.push({ msg: 'Please confirm your password', field: 'password2' });
  }

  // Validate first name
  if (firstName && (firstName.trim().length < 2 || firstName.trim().length > 50)) {
    errors.push({ msg: 'First name must be between 2 and 50 characters', field: 'firstName' });
  }

  // Validate last name
  if (lastName && (lastName.trim().length < 2 || lastName.trim().length > 50)) {
    errors.push({ msg: 'Last name must be between 2 and 50 characters', field: 'lastName' });
  }

  // Validate username
  if (username && (username.trim().length < 3 || username.trim().length > 30)) {
    errors.push({ msg: 'Username must be between 3 and 30 characters', field: 'username' });
  }

  // Validate username format (alphanumeric and underscores only)
  const usernameRegex = /^[a-zA-Z0-9_]+$/;
  if (username && username.trim() && !usernameRegex.test(username.trim())) {
    errors.push({
      msg: 'Username can only contain letters, numbers, and underscores',
      field: 'username',
    });
  }

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (userEmail && !emailRegex.test(userEmail.trim())) {
    errors.push({ msg: 'Please enter a valid email address', field: 'studentEmail' });
  }

  // Check passwords match
  if (password && password2 && password !== password2) {
    errors.push({ msg: 'Passwords do not match', field: 'password2' });
  }

  // Check password strength
  if (password && password.length < 6) {
    errors.push({ msg: 'Password must be at least 6 characters long', field: 'password' });
  }

  // Check terms acceptance
  if (!termsAccepted) {
    errors.push({ msg: 'You must accept the terms of service', field: 'termsCheck' });
  }

  // Validate parent phone is different from student phone if both are provided
  if (studentNumber && parentNumber) {
    const cleanStudentPhone = studentNumber.replace(/\D/g, '');
    const cleanParentPhone = parentNumber.replace(/\D/g, '');

    // If both have the same country code and number
    if (studentCountryCode === parentCountryCode && cleanStudentPhone === cleanParentPhone) {
      errors.push({
        msg: 'Parent phone number must be different from student phone number',
        field: 'parentNumber'
      });
    }
  }

  if (errors.length > 0) {
    return res.render('auth/register', {
      title: 'Register | G-Teacher',
      theme: req.cookies.theme || 'light',
      errors,
      firstName,
      lastName,
      username,
      grade,
      curriculum,
      howDidYouKnow,
      howDidYouKnowOther,
      email: userEmail,
      studentEmail: userEmail,
      studentNumber,
      studentCountryCode,
      parentNumber,
      parentCountryCode,
    });
  }

  try {
    // Check for existing user data in parallel for better performance
    const [existingEmail, existingUsername] = await Promise.all([
      User.findOne({ studentEmail: userEmail.toLowerCase() }),
      User.findOne({ username: username.trim() }),
    ]);

    // Collect all validation errors at once
    if (existingEmail) {
      errors.push({
        msg: 'Email is already registered',
        field: 'studentEmail',
      });
    }

    if (existingUsername) {
      errors.push({
        msg: 'Username is already taken',
        field: 'username',
      });
    }

    // Return all errors at once if any exist
    if (errors.length > 0) {
      console.log('Registration validation errors:', errors);
      return res.render('auth/register', {
        title: 'Register | G-Teacher',
        theme: req.cookies.theme || 'light',
        errors,
        firstName,
        lastName,
        username,
        email: userEmail,
        studentEmail: userEmail,
        grade,
        curriculum,
        howDidYouKnow,
        howDidYouKnowOther,
        studentNumber,
        studentCountryCode,
        parentNumber,
        parentCountryCode,
      });
    }

    // Create new user with registration data
    const newUser = new User({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      studentEmail: userEmail.toLowerCase().trim(),
      username: username.trim(),
      password,
      grade: grade,
      curriculum: curriculum,
      howDidYouKnow: howDidYouKnow === 'Other' ? howDidYouKnowOther?.trim() : howDidYouKnow,
      isActive: true, // Students are automatically active upon registration
      isCompleteData: true, // Profile data is now complete with new fields
    });

    // Add phone numbers if provided
    if (studentNumber && studentCountryCode) {
      newUser.studentNumber = studentNumber.replace(/\D/g, ''); // Store digits only
      newUser.studentCountryCode = studentCountryCode;
    }

    if (parentNumber && parentCountryCode) {
      newUser.parentNumber = parentNumber.replace(/\D/g, ''); // Store digits only
      newUser.parentCountryCode = parentCountryCode;
    }

    const savedUser = await newUser.save();

    // Flash success message and redirect to login
    req.flash('success_msg', 'Registration successful! You can now log in with your credentials.');
    return res.redirect('/auth/login');

  } catch (err) {
    console.error('Registration error:', err);

    // Handle mongoose validation errors
    if (err.name === 'ValidationError') {
      const validationErrors = Object.values(err.errors).map((e) => ({
        msg: e.message,
        field: e.path,
      }));
      errors.push(...validationErrors);

      console.log('Mongoose validation errors:', validationErrors);

      return res.render('auth/register', {
        title: 'Register | G-Teacher',
        theme: req.cookies.theme || 'light',
        errors,
        firstName,
        lastName,
        username,
        email,
      });
    }

    // Handle duplicate key errors
    if (err.code === 11000) {
      const field = Object.keys(err.keyValue)[0];
      const fieldName = field.charAt(0).toUpperCase() + field.slice(1);

      errors.push({
        msg: `${fieldName} is already in use`,
        field: field,
      });

      console.log('Duplicate key error:', field, err.keyValue[field]);

      return res.render('auth/register', {
        title: 'Register | G-Teacher',
        theme: req.cookies.theme || 'light',
        errors,
        firstName,
        lastName,
        username,
        email,
      });
    }

    // Generic error for other cases
    req.flash(
      'error_msg',
      'An error occurred during registration. Please try again or contact support if the issue persists.'
    );
    res.redirect('/auth/register');
  }
};

// Login user
const loginUser = async (req, res) => {
  const { email, password, rememberMe, submissionId } = req.body;
  let errors = [];

  // Check if this is a duplicate submission (browser refresh or back button)
  // Only check if submissionId is provided and not undefined
  if (submissionId && req.session.lastLoginSubmissionId === submissionId) {
    console.log('Duplicate login submission detected:', submissionId);
    req.flash(
      'error_msg',
      'Your login request is already being processed. Please do not refresh or resubmit the form.'
    );
    return res.redirect('/auth/login');
  }

  // Store current submission ID in session only if provided
  if (submissionId) {
    req.session.lastLoginSubmissionId = submissionId;
  }

  // Validate input
  if (!email || !password) {
    errors.push({ msg: 'Please provide both email/phone and password' });
  }

  if (errors.length > 0) {
    // Reset submission ID to allow retrying
    req.session.lastLoginSubmissionId = null;

    return res.render('auth/login', {
      title: 'Login | G-Teacher',
      theme: req.cookies.theme || 'light',
      errors,
      email,
    });
  }

  try {
    let user;
    const inputValue = email.trim();

    // Simple check if input contains @ (email)
    if (inputValue.includes('@')) {
      // Try to find by email in both User and Admin models
      user = await User.findOne({ studentEmail: inputValue.toLowerCase() });
      if (!user) {
        user = await Admin.findOne({ email: inputValue.toLowerCase() });
      }
    } else if (inputValue.match(/^[\d\s\-\(\)\+]+$/)) {
      // If input contains only digits, spaces, dashes, parentheses, or plus (phone number)
      user = await User.findOne({
        $or: [
          { studentNumber: inputValue },
          {
            $expr: {
              $eq: [
                { $concat: ['$studentCountryCode', '$studentNumber'] },
                inputValue,
              ],
            },
          },
        ],
      });
      if (!user) {
        user = await Admin.findOne({ phoneNumber: inputValue });
      }
    } else {
      // Otherwise treat as username
      user = await User.findOne({
        username: { $regex: new RegExp(`^${inputValue}$`, 'i') },
      });
      if (!user) {
        user = await Admin.findOne({
          userName: { $regex: new RegExp(`^${inputValue}$`, 'i') },
        });
      }
    }
    console.log('User found:', user);
    if (!user) {
      errors.push({ msg: 'Invalid email, phone number, or username' });
      return res.render('auth/login', {
        title: 'Login | G-Teacher',
        theme: req.cookies.theme || 'light',
        errors,
        email,
      });
    }

    // Match password (both models implement matchPassword)
    const isMatch = await user.matchPassword(password);

    if (!isMatch) {
      errors.push({ msg: 'Invalid email, phone number, or username' });
      return res.render('auth/login', {
        title: 'Login | G-Teacher',
        theme: req.cookies.theme || 'light',
        errors,
        email,
      });
    }

    // Check if user is active (only for students)
    if (user.role === 'student' && user.isActive === false) {
      errors.push({
        msg: 'Your account is pending approval. Please contact the administrator or wait for approval.',
      });
      return res.render('auth/login', {
        title: 'Login | G-Teacher',
        theme: req.cookies.theme || 'light',
        errors,
        email,
      });
    }

    // Set session configuration based on remember me
    if (rememberMe) {
      req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
    } else {
      req.session.cookie.maxAge = 24 * 60 * 60 * 1000; // 1 day
    }

    // Generate session token for students to enforce single device login
    let sessionToken = null;
    if (user.role === 'student') {
      sessionToken = crypto.randomBytes(32).toString('hex');
      // Update user with new session token (this invalidates any previous sessions)
      user.sessionToken = sessionToken;
      await user.save();
    }

    // Create session
    if (user.role === 'admin') {
      req.session.user = {
        id: user._id,
        name: user.userName || user.name,
        email: user.email,
        role: user.role,
        phoneNumber: user.phoneNumber,
        isActive: user.isActive,
      };
    } else {
      req.session.user = {
        id: user._id,
        name: user.name, // This uses the virtual field
        firstName: user.firstName,
        lastName: user.lastName,
        studentEmail: user.studentEmail,
        username: user.username,
        role: user.role,
        grade: user.grade,
        schoolName: user.schoolName,
        studentCode: user.studentCode,
        studentNumber: user.studentNumber,
        studentCountryCode: user.studentCountryCode,
        parentNumber: user.parentNumber,
        parentCountryCode: user.parentCountryCode,
        englishTeacher: user.englishTeacher,
        isActive: user.isActive,
        sessionToken: sessionToken, // Store session token in session for validation
      };
    }

    // Save session and redirect based on role
    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        errors.push({
          msg: 'An error occurred during login. Please try again.',
        });
        return res.render('auth/login', {
          title: 'Login | G-Teacher',
          theme: req.cookies.theme || 'light',
          errors,
          email,
        });
      }

      // Simple redirect based on role
      if (user.role === 'admin' || user.role === 'superAdmin') {
        return res.redirect('/admin/dashboard');
      } else {
        return res.redirect('/student/dashboard');
      }
    });
  } catch (err) {
    console.error('Login error:', err);

    // Reset submission ID to allow retrying
    req.session.lastLoginSubmissionId = null;

    // Handle different types of errors
    if (err.name === 'MongoServerError') {
      errors.push({
        msg: 'Database connection error. Please try again later.',
      });
    } else if (err.name === 'ValidationError') {
      errors.push({
        msg: 'Invalid login credentials. Please check your information.',
      });
    } else if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      errors.push({
        msg: 'Network connection issue. Please check your internet connection and try again.',
      });
    } else {
      errors.push({ msg: 'An error occurred during login. Please try again.' });
    }

    // Log detailed error for debugging
    console.error('Login error details:', {
      name: err.name,
      message: err.message,
      code: err.code,
      stack: err.stack,
    });

    return res.render('auth/login', {
      title: 'Login | G-Teacher',
      theme: req.cookies.theme || 'light',
      errors,
      email,
    });
  }
};

// Logout user
const logoutUser = async (req, res) => {
  // Clear session token from user document if student
  if (
    req.session &&
    req.session.user &&
    req.session.user.role === 'student' &&
    req.session.user.id
  ) {
    try {
      const user = await User.findById(req.session.user.id);
      if (user) {
        user.sessionToken = null;
        await user.save();
      }
    } catch (err) {
      console.error('Error clearing session token on logout:', err);
    }
  }

  req.session.destroy((err) => {
    if (err) {
      console.error('Logout error:', err);
    }
    res.clearCookie('G-Teacher.session');
    res.redirect('/auth/login');
  });
};

// Get forgot password page
const getForgotPasswordPage = (req, res) => {
  // Clear all forgot password session data on page load/refresh
  // This ensures users start fresh if they refresh the page
  delete req.session.forgot_password_phone_verified;
  delete req.session.forgot_password_phone_number;
  delete req.session.forgot_password_country_code;
  delete req.session.forgot_password_user_id;
  delete req.session.forgot_password_otp;
  delete req.session.forgot_password_otp_expiry;
  delete req.session.forgot_password_otp_attempts;
  delete req.session.forgot_password_otp_blocked_until;
  delete req.session.lastResetPasswordSubmissionId;

  res.render('auth/forgot-password', {
    title: 'Forgot Password | G-Teacher',
    theme: req.cookies.theme || 'light',
    phoneVerified: false,
    phoneNumber: '',
    countryCode: '',
    userId: '',
  });
};

// Initiate forgot password - find account and prepare for OTP
const initiateForgotPassword = async (req, res) => {
  try {
    const { identifier } = req.body;

    if (!identifier || identifier.trim().length < 3) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid phone number, username, or email',
      });
    }

    const inputValue = identifier.trim();
    let user = null;

    // Try to find user by email
    if (inputValue.includes('@')) {
      user = await User.findOne({ studentEmail: inputValue.toLowerCase() });
    }
    // Try to find by phone number
    else if (inputValue.match(/^[\d\s\-\(\)\+]+$/)) {
      // Try with country code
      user = await User.findOne({
        $or: [
          { studentNumber: inputValue.replace(/[^\d]/g, '') },
          {
            $expr: {
              $eq: [
                { $concat: ['$studentCountryCode', '$studentNumber'] },
                inputValue,
              ],
            },
          },
        ],
      });
    }
    // Try to find by username
    else {
      user = await User.findOne({
        username: { $regex: new RegExp(`^${inputValue}$`, 'i') },
      });
    }

    if (!user) {
      return res.status(404).json({
        success: false,
        message:
          'Account not found. Please check your phone number, username, or email.',
      });
    }

    // Store user ID and phone info in session for password reset
    req.session.forgot_password_user_id = user._id.toString();
    req.session.forgot_password_phone_verified = false;
    req.session.forgot_password_phone_number = user.studentNumber;
    req.session.forgot_password_country_code = user.studentCountryCode;

    return res.json({
      success: true,
      userId: user._id.toString(),
      phoneNumber: user.studentNumber,
      countryCode: user.studentCountryCode,
      message:
        'Account found. OTP will be sent to your registered phone number.',
    });
  } catch (error) {
    console.error('Initiate forgot password error:', error);
    return res.status(500).json({
      success: false,
      message: 'An error occurred. Please try again.',
    });
  }
};

// Send OTP for forgot password
const sendForgotPasswordOTP = async (req, res) => {
  try {
    const { phoneNumber, countryCode } = req.body;

    if (!phoneNumber || !countryCode) {
      return res.status(400).json({
        success: false,
        message: 'Phone number and country code are required',
      });
    }

    // Verify user ID is in session
    if (!req.session.forgot_password_user_id) {
      return res.status(400).json({
        success: false,
        message: 'Session expired. Please start over.',
      });
    }

    // Verify phone number matches session
    const cleanPhoneNumber = phoneNumber.replace(/[^\d]/g, '');
    if (cleanPhoneNumber !== req.session.forgot_password_phone_number) {
      return res.status(400).json({
        success: false,
        message: 'Phone number mismatch. Please start over.',
      });
    }

    // Rate limiting: Check OTP send attempts (3 attempts per hour)
    const attemptsKey = 'forgot_password_otp_attempts';
    const attemptsBlockedKey = 'forgot_password_otp_blocked_until';
    const maxAttempts = 3;
    const blockDuration = 60 * 60 * 1000; // 1 hour

    if (!req.session[attemptsKey]) {
      req.session[attemptsKey] = 0;
    }

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

    if (blockedUntil && Date.now() >= blockedUntil) {
      req.session[attemptsKey] = 0;
      delete req.session[attemptsBlockedKey];
    }

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

    // Increment attempts
    req.session[attemptsKey] = (req.session[attemptsKey] || 0) + 1;

    // Generate OTP
    const otp = generateOTP();
    console.log('Forgot Password OTP:', otp);
    const fullPhoneNumber = countryCode + cleanPhoneNumber;

    // Store OTP in session with expiration (5 minutes)
    req.session.forgot_password_otp = otp;
    req.session.forgot_password_otp_expiry = Date.now() + 5 * 60 * 1000;
    req.session.forgot_password_phone_verified = false;

    // Check if country code is NOT Egyptian (+20)
    const isEgyptian = countryCode === '+20' || countryCode === '20';
    const message = `Your G-Teacher password reset code is: ${otp}. Valid for 5 minutes. Do not share this code.`;

    try {
      if (isEgyptian) {
        // Send via SMS for Egyptian numbers
        await sendSms({
          recipient: fullPhoneNumber,
          message: message,
        });
        console.log(`Forgot password OTP sent via SMS to ${fullPhoneNumber}`);
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

        console.log(`Forgot password OTP sent via WhatsApp to ${fullPhoneNumber}`);
      }

      return res.json({
        success: true,
        message: 'OTP sent successfully',
        expiresIn: 300,
        attemptsRemaining: maxAttempts - req.session[attemptsKey],
      });
    } catch (error) {
      console.error(`${isEgyptian ? 'SMS' : 'WhatsApp'} sending error:`, error);

      delete req.session.forgot_password_otp;
      delete req.session.forgot_password_otp_expiry;

      return res.status(500).json({
        success: false,
        message: 'Failed to send OTP. Please try again.',
        error: error.message,
      });
    }
  } catch (error) {
    console.error('Send forgot password OTP error:', error);
    return res.status(500).json({
      success: false,
      message: 'An error occurred while sending OTP',
      error: error.message,
    });
  }
};

// Verify OTP for forgot password
const verifyForgotPasswordOTP = async (req, res) => {
  try {
    const { otp } = req.body;

    if (!otp) {
      return res.status(400).json({
        success: false,
        message: 'OTP is required',
      });
    }

    // Verify user ID is in session
    if (!req.session.forgot_password_user_id) {
      return res.status(400).json({
        success: false,
        message: 'Session expired. Please start over.',
      });
    }

    const storedOTP = req.session.forgot_password_otp;
    const expiryTime = req.session.forgot_password_otp_expiry;

    if (!storedOTP || !expiryTime) {
      return res.status(400).json({
        success: false,
        message: 'OTP not found or expired. Please request a new OTP.',
      });
    }

    if (Date.now() > expiryTime) {
      delete req.session.forgot_password_otp;
      delete req.session.forgot_password_otp_expiry;
      return res.status(400).json({
        success: false,
        message: 'OTP has expired. Please request a new OTP.',
      });
    }

    if (otp.toString() !== storedOTP.toString()) {
      return res.status(400).json({
        success: false,
        message: 'Invalid OTP. Please try again.',
      });
    }

    // Mark phone as verified
    req.session.forgot_password_phone_verified = true;

    // Clear OTP from session (one-time use)
    delete req.session.forgot_password_otp;
    delete req.session.forgot_password_otp_expiry;

    // Reset OTP attempts counter on successful verification
    delete req.session.forgot_password_otp_attempts;
    delete req.session.forgot_password_otp_blocked_until;

    return res.json({
      success: true,
      message: 'OTP verified successfully',
    });
  } catch (error) {
    console.error('Verify forgot password OTP error:', error);
    return res.status(500).json({
      success: false,
      message: 'An error occurred while verifying OTP',
      error: error.message,
    });
  }
};

// Reset password
const resetPassword = async (req, res) => {
  try {
    const { userId, newPassword, confirmPassword, submissionId } = req.body;

    // Check duplicate submission
    if (
      submissionId &&
      req.session.lastResetPasswordSubmissionId === submissionId
    ) {
      console.log(
        'Duplicate reset password submission detected:',
        submissionId
      );
      req.flash(
        'error_msg',
        'Your password reset is already being processed. Please do not refresh or resubmit the form.'
      );
      return res.redirect('/auth/forgot-password');
    }

    if (submissionId) {
      req.session.lastResetPasswordSubmissionId = submissionId;
    }

    let errors = [];

    // Verify session
    if (!req.session.forgot_password_user_id) {
      errors.push({ msg: 'Session expired. Please start over.' });
      return res.render('auth/forgot-password', {
        title: 'Forgot Password | G-Teacher',
        theme: req.cookies.theme || 'light',
        errors,
        phoneVerified: false,
      });
    }

    // Verify OTP was verified
    if (!req.session.forgot_password_phone_verified) {
      errors.push({ msg: 'Please verify OTP first' });
      return res.render('auth/forgot-password', {
        title: 'Forgot Password | G-Teacher',
        theme: req.cookies.theme || 'light',
        errors,
        phoneVerified: false,
      });
    }

    // Verify user ID matches
    const sessionUserId = req.session.forgot_password_user_id;
    if (userId !== sessionUserId) {
      errors.push({ msg: 'User ID mismatch. Please start over.' });
      return res.render('auth/forgot-password', {
        title: 'Forgot Password | G-Teacher',
        theme: req.cookies.theme || 'light',
        errors,
        phoneVerified: false,
      });
    }

    // Validate passwords
    if (!newPassword || !confirmPassword) {
      errors.push({ msg: 'Please fill in all required fields' });
    }

    if (newPassword && newPassword.length < 6) {
      errors.push({ msg: 'Password must be at least 6 characters long' });
    }

    if (newPassword !== confirmPassword) {
      errors.push({ msg: 'Passwords do not match' });
    }

    if (errors.length > 0) {
      return res.render('auth/forgot-password', {
        title: 'Forgot Password | G-Teacher',
        theme: req.cookies.theme || 'light',
        errors,
        userId: sessionUserId,
        phoneVerified: req.session.forgot_password_phone_verified || false,
      });
    }

    // Find user
    const user = await User.findById(sessionUserId);
    if (!user) {
      errors.push({ msg: 'User not found' });
      // Clear session
      delete req.session.forgot_password_user_id;
      delete req.session.forgot_password_phone_verified;
      delete req.session.forgot_password_phone_number;
      delete req.session.forgot_password_country_code;

      return res.render('auth/forgot-password', {
        title: 'Forgot Password | G-Teacher',
        theme: req.cookies.theme || 'light',
        errors,
        phoneVerified: false,
      });
    }

    // Update password
    user.password = newPassword;
    await user.save();

    // Clear all forgot password session data
    delete req.session.forgot_password_user_id;
    delete req.session.forgot_password_phone_verified;
    delete req.session.forgot_password_phone_number;
    delete req.session.forgot_password_country_code;
    delete req.session.forgot_password_otp;
    delete req.session.forgot_password_otp_expiry;
    delete req.session.forgot_password_otp_attempts;
    delete req.session.forgot_password_otp_blocked_until;
    delete req.session.lastResetPasswordSubmissionId;

    req.flash(
      'success_msg',
      'Password reset successfully! You can now log in with your new password.'
    );
    res.redirect('/auth/login');
  } catch (error) {
    console.error('Reset password error:', error);

    // Reset submission ID
    req.session.lastResetPasswordSubmissionId = null;

    req.flash('error_msg', 'An error occurred. Please try again.');
    res.redirect('/auth/forgot-password');
  }
};

module.exports = {
  getLoginPage,
  getRegisterPage,
  registerUser,
  loginUser,
  logoutUser,
  getCreateAdminPage,
  createAdmin,
  // OTP functions
  sendOTP,
  verifyOTP,
  // Forgot Password functions
  getForgotPasswordPage,
  initiateForgotPassword,
  sendForgotPasswordOTP,
  verifyForgotPasswordOTP,
  resetPassword,
};
