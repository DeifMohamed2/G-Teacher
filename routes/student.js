const express = require('express');
const router = express.Router();
const path = require('path');
const studentController = require('../controllers/studentController');
const { ensureAuthenticated, ensureStudent, ensureDataComplete } = require('../middlewares/auth');
const multer = require('multer');

// Configure multer for profile picture uploads
const profilePictureUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit for profile pictures
  },
  fileFilter: (req, file, cb) => {
    // Allow only image files
    const allowedMimeTypes = [
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/gif',
      'image/webp'
    ];
    
    const allowedExtensions = /\.(jpg|jpeg|png|gif|webp)$/i;
    
    if (allowedMimeTypes.includes(file.mimetype) && allowedExtensions.test(file.originalname)) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files (JPG, PNG, GIF, WebP) are allowed for profile pictures'));
    }
  }
});

// Apply authentication middleware to all routes
router.use(ensureAuthenticated);
router.use(ensureStudent);
router.use(ensureDataComplete);

// Dashboard
router.get('/', studentController.dashboard);
router.get('/dashboard', studentController.dashboard);

// Enrolled Courses
router.get('/enrolled-courses', studentController.enrolledCourses);
router.get('/course/:id', studentController.courseDetails);
router.get('/course/:id/content', studentController.courseContent);
router.get('/content/:id', studentController.contentDetails);
router.post('/content/progress/update', studentController.updateContentProgress);

// Wishlist
router.get('/wishlist', studentController.wishlist);
router.post('/wishlist/add/:id', studentController.addToWishlist);
router.delete('/wishlist/remove/:id', studentController.removeFromWishlist);

// Order History
router.get('/order-history', studentController.orderHistory);
router.get('/order/:orderNumber', studentController.orderDetails);

// Profile
router.get('/profile', studentController.profile);
router.put('/profile/update', studentController.updateProfile);
router.post('/profile/update-picture', profilePictureUpload.single('profilePicture'), studentController.updateProfilePicture);
router.post('/profile/send-otp', studentController.sendProfileOTP);
router.post('/profile/verify-otp', studentController.verifyProfileOTP);

// Settings
router.get('/settings', studentController.settings);
router.put('/settings/update', studentController.updateSettings);
router.put('/settings/change-password', studentController.changePassword);
router.get('/settings/export-data', studentController.exportData);
router.delete('/settings/delete-account', studentController.deleteAccount);

// Configure multer for submission file uploads
const submissionStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadsDir = path.join(__dirname, '../public/uploads/submissions');
    if (!require('fs').existsSync(uploadsDir)) {
      require('fs').mkdirSync(uploadsDir, { recursive: true });
    }
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, 'submission-' + uniqueSuffix + path.extname(file.originalname));
  },
});

const submissionUpload = multer({
  storage: submissionStorage,
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB limit per file
    files: 10, // Maximum 10 files
  },
  fileFilter: (req, file, cb) => {
    // Allow various document types
    const allowedMimeTypes = [
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/gif',
      'image/webp',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain',
    ];

    const allowedExtensions = /\.(jpg|jpeg|png|gif|webp|pdf|doc|docx|xls|xlsx|ppt|pptx|txt)$/i;

    if (allowedMimeTypes.includes(file.mimetype) || allowedExtensions.test(file.originalname)) {
      return cb(null, true);
    } else {
      cb(new Error('File type not allowed. Allowed: Images, PDF, Word, Excel, PowerPoint, Text files'));
    }
  },
});

// Submission Routes
router.post('/submission/submit', submissionUpload.array('files', 10), studentController.submitAssignment);
router.get('/submission/:contentId', studentController.getSubmission);
router.delete('/submission/:submissionId/file/:fileIndex', studentController.deleteSubmissionFile);

// Error handler for multer file upload errors
const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ 
        success: false, 
        message: 'Profile picture too large. Maximum file size is 5MB.' 
      });
    }
    return res.status(400).json({ 
      success: false, 
      message: 'File upload error: ' + err.message 
    });
  }
  
  if (err.message.includes('Only image files')) {
    return res.status(400).json({ 
      success: false, 
      message: err.message 
    });
  }
  
  next(err);
};

// Apply multer error handler
router.use(handleMulterError);

// Logout - redirect to auth logout
router.post('/logout', (req, res) => res.redirect('/auth/logout'));
router.get('/logout', (req, res) => res.redirect('/auth/logout'));

module.exports = router;
