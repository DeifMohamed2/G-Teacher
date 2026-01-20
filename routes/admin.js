const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { isAdmin } = require('../middlewares/auth');
const { isSuperAdmin } = require('../middlewares/isSuperAdmin');

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    // Create uploads directory if it doesn't exist
    const uploadsDir = path.join(__dirname, '../uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, 'bulk-import-' + uniqueSuffix + path.extname(file.originalname));
  },
});

const uploadFile = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: function (req, file, cb) {
    const allowedExtensions = ['.xlsx', '.xls'];
    const fileExtension = path.extname(file.originalname).toLowerCase();
    if (allowedExtensions.includes(fileExtension)) {
      cb(null, true);
    } else {
      cb(new Error('Only Excel files (.xlsx, .xls) are allowed'));
    }
  },
});

// Configure multer for PDF uploads
const pdfStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    // Create uploads directory if it doesn't exist
    const uploadsDir = path.join(__dirname, '../public/uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    // Generate unique filename with timestamp and original extension
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, 'pdf-' + uniqueSuffix + path.extname(file.originalname));
  },
});

const uploadPDFMiddleware = multer({
  storage: pdfStorage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit for PDFs
  fileFilter: function (req, file, cb) {
    // Only allow PDF files
    if (file.mimetype === 'application/pdf' || path.extname(file.originalname).toLowerCase() === '.pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  },
});

const {
  getAdminDashboard,
  getDashboardChartData,
  getCourses,
  createCourse,
  getCourse,
  getCourseDetails,
  getCourseData,
  updateCourse,
  deleteCourse,
  duplicateCourse,
  bulkUpdateCourseStatus,
  getCourseContent,
  createTopic,
  updateTopic,
  updateTopicVisibility,
  getTopicDetails,
  reorderTopics,
  reorderContent,
  duplicateTopic,
  deleteTopic,
  addTopicContent,
  updateTopicContent,
  deleteTopicContent,
  getContentDetailsPage,
  getContentDetailsForEdit,
  // Student Management Controllers
  getStudents,
  getStudentDetails,
  getStudentEditPage,
  toggleStudentStatus,
  toggleParentPhoneStatus,
  bulkToggleStudentStatus,
  exportStudentData,
  updateStudent,
  deleteStudent,
  // Orders
  getOrders,
  getOrderDetails,
  generateInvoice,
  refundOrder,
  completeFailedPayment,
  getBookOrders,
  updateBookOrderStatus,
  bulkUpdateBookOrdersStatus,
  exportBookOrders,
  // Brilliant Students Management
  getBrilliantStudents,
  getBrilliantStudentDetails,
  createBrilliantStudent,
  updateBrilliantStudent,
  deleteBrilliantStudent,
  reorderBrilliantStudents,
  getBrilliantStudentsStats,
  exportBrilliantStudents,
  // Admin Management
  getCreateAdminForm,
  createNewAdmin,
  updateAdmin,
  deleteAdmin,
  toggleAdminStatus,
  // Export functions
  exportCourses,
  exportOrders,
  exportComprehensiveReport,
  exportCourseDetails,
  exportTopicDetails,
  // Zoom Meeting Management
  createZoomMeeting,
  startZoomMeeting,
  endZoomMeeting,
  getZoomMeetingStats,
  deleteZoomMeeting,
  // Bulk Import
  bulkImportStudents,
  downloadBulkImportSample,
  // Student Enrollment
  enrollStudentsToCourse,
  bulkEnrollStudentsToCourse,
  downloadEnrollmentTemplate,
  getStudentsForEnrollment,
  removeStudentFromCourse,
  // Duplicate Cleanup
  cleanupUserDuplicates,
  // Promo Codes Management
  getPromoCodes,
  getPromoCode,
  createPromoCode,
  getPromoCodeUsage,
  deletePromoCode,
  updatePromoCode,
  // Bulk Promo Codes Management
  createBulkPromoCodes,
  getBulkCollections,
  getBulkCollectionDetails,
  exportBulkCollection,
  deleteBulkCollection,
  toggleBulkCollectionStatus,
  // Team Management (moved from authController)
  getTeamManagementPage,
  getTeamMember,
  createTeamMember,
  updateTeamMember,
  deleteTeamMember,
  reorderTeamMembers,
  exportTeamMembers,
  // Bulk SMS Messaging
  getBulkSMSPage,
  getStudentsForSMS,
  getCoursesForSMS,
  getCourseStudentsCount,
  sendBulkSMS,
  uploadPDF,
  // OTP Master Generator
  getOTPMasterGenerator,
  generateMasterOTP,
  validateMasterOTP,
  getActiveMasterOTPs,
  revokeMasterOTP,
} = require('../controllers/adminController');

// Team Management is now imported from adminController (moved from authController)

// Import WhatsApp Controllers
const {
  getWhatsAppDashboard,
  getSessionManagement,
  createSession,
  connectSession,
  getQRCode,
  disconnectSession,
  deleteSession,
  sendBulkMessage,
  sendTestMessage,
  getStudentsForMessaging,
  getCoursesForMessaging,
  getSessionStatus,
  getSessionDetails,
  testInvoiceGeneration,
} = require('../controllers/whatsappController');

// Import Admin Log Controllers
const {
  getAdminLogs,
  getLogDetails,
  getLogsStats,
  exportLogs,
  deleteOldLogs,
} = require('../controllers/adminLogController');

// Admin Dashboard
router.get('/dashboard', isAdmin, getAdminDashboard);
router.get('/dashboard/chart-data', isAdmin, getDashboardChartData);

// Course Routes
router.get('/courses', isAdmin, getCourses);
router.post('/courses/create', isAdmin, createCourse);
router.get('/courses/:courseCode', isAdmin, getCourse);
router.get('/courses/:courseCode/details', isAdmin, getCourseDetails);
router.get('/courses/:courseCode/data', isAdmin, getCourseData);
router.put('/courses/:courseCode', isAdmin, updateCourse);
router.delete('/courses/:courseCode', isAdmin, deleteCourse);
router.post('/courses/:courseCode/duplicate', isAdmin, duplicateCourse);
router.post('/courses/bulk-status', isAdmin, bulkUpdateCourseStatus);

// Course Content Management
router.get('/courses/:courseCode/content', isAdmin, getCourseContent);
router.get(
  '/courses/:courseCode/topics/:topicId/details',
  isAdmin,
  getTopicDetails
);
router.post('/courses/:courseCode/topics/create', isAdmin, createTopic);
router.put('/courses/:courseCode/topics/reorder', isAdmin, reorderTopics);
router.put(
  '/courses/:courseCode/topics/:topicId/content/reorder',
  isAdmin,
  reorderContent
);
router.put(
  '/courses/:courseCode/topics/:topicId/visibility',
  isAdmin,
  updateTopicVisibility
);
router.put('/courses/:courseCode/topics/:topicId', isAdmin, updateTopic);
router.post('/courses/:courseCode/topics/:topicId/duplicate', isAdmin, duplicateTopic);
router.delete('/courses/:courseCode/topics/:topicId', isAdmin, deleteTopic);
router.post(
  '/courses/:courseCode/topics/:topicId/content/create',
  isAdmin,
  addTopicContent
);
router.get(
  '/courses/:courseCode/topics/:topicId/content/:contentId/details',
  isAdmin,
  getContentDetailsPage
);
router.get(
  '/courses/:courseCode/topics/:topicId/content/:contentId/edit-details',
  isAdmin,
  getContentDetailsForEdit
);
router.put(
  '/courses/:courseCode/topics/:topicId/content/:contentId',
  isAdmin,
  updateTopicContent
);
router.delete(
  '/courses/:courseCode/topics/:topicId/content/:contentId',
  isAdmin,
  deleteTopicContent
);

// Student Management Routes
router.get('/students', isAdmin, getStudents);
router.get('/students/export', isAdmin, exportStudentData);
router.get('/students/bulk-import/sample', isAdmin, downloadBulkImportSample);
router.get('/enrollment-template.xlsx', isAdmin, downloadEnrollmentTemplate);
router.post(
  '/students/bulk-import',
  isAdmin,
  uploadFile.single('excelFile'),
  bulkImportStudents
);
router.get('/students/:studentId/edit', isAdmin, getStudentEditPage);
router.post(
  '/students/:studentId/update',
  isAdmin,
  uploadFile.single('profilePicture'),
  updateStudent
);
router.get('/students/:studentId', isAdmin, getStudentDetails);
router.get('/students/:studentId/export', isAdmin, exportStudentData);
router.put('/students/:studentId/status', isAdmin, toggleStudentStatus);
router.put(
  '/students/:studentId/parent-phone-status',
  isAdmin,
  toggleParentPhoneStatus
);
router.put('/students/bulk-status', isAdmin, bulkToggleStudentStatus);
router.put('/students/:studentId', isAdmin, updateStudent);
router.delete('/students/:studentId', isAdmin, deleteStudent);

// Student Enrollment Routes
router.get('/api/students-for-enrollment', isAdmin, getStudentsForEnrollment);
router.post('/courses/:courseId/enroll', isAdmin, enrollStudentsToCourse);
router.post(
  '/courses/:courseId/bulk-enroll',
  isAdmin,
  uploadFile.single('excelFile'),
  bulkEnrollStudentsToCourse
);
router.delete(
  '/courses/:courseId/students/:studentId',
  isAdmin,
  removeStudentFromCourse
);

// Orders Management
router.get('/orders', isAdmin, getOrders);
router.get('/orders/export', isAdmin, exportOrders);
router.get('/orders/:orderNumber', isAdmin, getOrderDetails);
router.get('/orders/:orderNumber/invoice', isAdmin, generateInvoice);
router.post('/orders/:orderNumber/refund', isAdmin, refundOrder);
router.post('/orders/:orderNumber/complete-failed', isAdmin, completeFailedPayment);

// Book Orders Management
router.get('/book-orders', isAdmin, getBookOrders);
router.get('/book-orders/export', isAdmin, exportBookOrders);
router.get('/book-orders/:bookOrderId', isAdmin, async (req, res) => {
  try {
    const BookOrder = require('../models/BookOrder');
    const bookOrder = await BookOrder.findById(req.params.bookOrderId)
      .populate('user', 'firstName lastName studentEmail')
      .populate('course', 'title courseCode _id')
      .lean();

    if (!bookOrder) {
      return res.status(404).json({
        success: false,
        message: 'Book order not found',
      });
    }

    return res.json({
      success: true,
      bookOrder,
    });
  } catch (error) {
    console.error('Error fetching book order:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching book order',
    });
  }
});
router.put('/book-orders/:bookOrderId/update', isAdmin, updateBookOrderStatus);
router.put('/book-orders/bulk-update', isAdmin, bulkUpdateBookOrdersStatus);

// Admin Management Routes
router.get('/create-admin', isAdmin, getCreateAdminForm);
router.post('/create-admin', isAdmin, createNewAdmin);
router.put('/admins/:adminId', isAdmin, updateAdmin);
router.delete('/admins/:adminId', isAdmin, deleteAdmin);
router.post('/admins/:adminId/toggle-status', isAdmin, toggleAdminStatus);

// Brilliant Students Management Routes
router.get('/brilliant-students', isAdmin, getBrilliantStudents);
router.post('/brilliant-students', isAdmin, createBrilliantStudent);
router.get('/brilliant-students/export', isAdmin, exportBrilliantStudents);
router.get('/brilliant-students/stats', isAdmin, getBrilliantStudentsStats);
router.put('/brilliant-students/reorder', isAdmin, reorderBrilliantStudents);
router.get('/brilliant-students/:id', isAdmin, getBrilliantStudentDetails);
router.put('/brilliant-students/:id', isAdmin, updateBrilliantStudent);
router.delete('/brilliant-students/:id', isAdmin, deleteBrilliantStudent);

// Excel Export Routes
router.get('/export/courses', isAdmin, exportCourses);
router.get('/courses/:courseId/export', isAdmin, exportCourseDetails);
router.get(
  '/courses/:courseCode/topics/:topicId/export',
  isAdmin,
  exportTopicDetails
);
router.get('/export/orders', isAdmin, exportOrders);
router.get('/export/comprehensive', isAdmin, exportComprehensiveReport);

// Team Management Routes
router.get('/team-management', isAdmin, getTeamManagementPage);
router.post('/team-management', isAdmin, createTeamMember);
router.get('/team-management/export', isAdmin, exportTeamMembers);
router.put('/team-management/reorder', isAdmin, reorderTeamMembers);
router.get('/team-management/:id', isAdmin, getTeamMember);
router.put('/team-management/:id', isAdmin, updateTeamMember);
router.delete('/team-management/:id', isAdmin, deleteTeamMember);

// Promo Codes Management Routes
router.get('/promo-codes', isAdmin, getPromoCodes);
router.get('/promo-codes/:id', isAdmin, getPromoCode);
router.post('/promo-codes/create', isAdmin, createPromoCode);
router.get('/promo-codes/:id/usage', isAdmin, getPromoCodeUsage);
router.put('/promo-codes/:id/update', isAdmin, updatePromoCode);
router.delete('/promo-codes/:id/delete', isAdmin, deletePromoCode);

// Bulk Promo Codes Management Routes
router.post('/promo-codes/bulk/create', isAdmin, createBulkPromoCodes);
router.get('/promo-codes/bulk/collections', isAdmin, getBulkCollections);
router.get(
  '/promo-codes/bulk/collections/:bulkCollectionId',
  isAdmin,
  getBulkCollectionDetails
);
router.get(
  '/promo-codes/bulk/collections/:bulkCollectionId/export',
  isAdmin,
  exportBulkCollection
);
router.delete(
  '/promo-codes/bulk/collections/:bulkCollectionId',
  isAdmin,
  deleteBulkCollection
);
router.put(
  '/promo-codes/bulk/collections/:bulkCollectionId/status',
  isAdmin,
  toggleBulkCollectionStatus
);

// WhatsApp Management Routes
router.get('/whatsapp', isAdmin, getWhatsAppDashboard);
router.get('/whatsapp/sessions', isAdmin, getSessionManagement);
router.post('/whatsapp/sessions', isAdmin, createSession);
router.post('/whatsapp/sessions/:sessionId/connect', isAdmin, connectSession);
router.get('/whatsapp/sessions/:sessionId/qrcode', isAdmin, getQRCode);
router.post(
  '/whatsapp/sessions/:sessionId/disconnect',
  isAdmin,
  disconnectSession
);
router.delete('/whatsapp/sessions/:sessionId', isAdmin, deleteSession);
router.post('/whatsapp/bulk-message', isAdmin, sendBulkMessage);
router.post('/whatsapp/test-message', isAdmin, sendTestMessage);
router.get('/whatsapp/students', isAdmin, getStudentsForMessaging);
router.get('/whatsapp/courses', isAdmin, getCoursesForMessaging);
router.get('/whatsapp/session-status', isAdmin, getSessionStatus);
router.get('/whatsapp/session-details', isAdmin, getSessionDetails);

// Bulk SMS Messaging Routes
router.get('/bulk-sms', isAdmin, getBulkSMSPage);
router.get('/bulk-sms/students', isAdmin, getStudentsForSMS);
router.get('/bulk-sms/courses', isAdmin, getCoursesForSMS);
router.get(
  '/bulk-sms/course-students-count/:courseId',
  isAdmin,
  getCourseStudentsCount
);
router.post('/bulk-sms/send', isAdmin, sendBulkSMS);

// PDF Upload Route
router.post('/upload/pdf', isAdmin, uploadPDFMiddleware.single('pdf'), (err, req, res, next) => {
  // Handle multer errors
  if (err) {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          success: false,
          message: 'File too large. Maximum file size is 50MB.',
        });
      }
      return res.status(400).json({
        success: false,
        message: 'File upload error: ' + err.message,
      });
    }
    return res.status(400).json({
      success: false,
      message: err.message || 'File upload error',
    });
  }
  next();
}, uploadPDF);

router.get('/whatsapp/session-details', isAdmin, getSessionDetails);

// Duplicate cleanup routes
router.post('/cleanup-duplicates/:userId', isAdmin, cleanupUserDuplicates);

// OTP Master Generator Routes
router.get('/otp-master', isAdmin, getOTPMasterGenerator);
router.post('/otp-master/generate', isAdmin, generateMasterOTP);
router.post('/otp-master/validate', isAdmin, validateMasterOTP);
router.get('/otp-master/active', isAdmin, getActiveMasterOTPs);
router.delete('/otp-master/:otpId/revoke', isAdmin, revokeMasterOTP);

// Admin Logs Routes (Super Admin Only)
router.get('/logs', isAdmin, isSuperAdmin, getAdminLogs);
router.get('/logs/export', isAdmin, isSuperAdmin, exportLogs);
router.get('/logs/stats', isAdmin, isSuperAdmin, getLogsStats);
router.get('/logs/:logId', isAdmin, isSuperAdmin, getLogDetails);
router.post('/logs/cleanup', isAdmin, isSuperAdmin, deleteOldLogs);

module.exports = router;
