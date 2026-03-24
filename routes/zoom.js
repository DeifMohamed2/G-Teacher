const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { google } = require('googleapis');
const zoomService = require('../utils/zoomService');
const youtubeService = require('../utils/youtubeService');
const { isAdmin, isStudent, isAuthenticated } = require('../middlewares/auth');
const {
  createZoomMeeting,
  startZoomMeeting,
  endZoomMeeting,
  getZoomMeetingStats,
  deleteZoomMeeting,
} = require('../controllers/adminController');
const {
  joinZoomMeeting,
  leaveZoomMeeting,
  getZoomMeetingHistory,
} = require('../controllers/studentController');

// ==================== ADMIN ROUTES ====================

// Create Zoom meeting for a topic
router.post(
  '/admin/courses/:courseCode/topics/:topicId/zoom/create',
  isAdmin,
  createZoomMeeting
);

// Start Zoom meeting (unlock for students)
router.post('/admin/zoom/:meetingId/start', isAdmin, startZoomMeeting);

// End Zoom meeting
router.post('/admin/zoom/:meetingId/end', isAdmin, endZoomMeeting);

// Add recording URL to ended meeting
router.post('/admin/zoom/:meetingId/add-recording', isAdmin, async (req, res) => {
  try {
    const { meetingId } = req.params;
    const { recordingUrl } = req.body;

    if (!recordingUrl || !recordingUrl.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Recording URL is required',
      });
    }

    const ZoomMeeting = require('../models/ZoomMeeting');
    const zoomMeeting = await ZoomMeeting.findById(meetingId);

    if (!zoomMeeting) {
      return res.status(404).json({
        success: false,
        message: 'Zoom meeting not found',
      });
    }

    if (zoomMeeting.status !== 'ended') {
      return res.status(400).json({
        success: false,
        message: 'Can only add recording URL to ended meetings',
      });
    }

    zoomMeeting.recordingUrl = recordingUrl.trim();
    zoomMeeting.recordingStatus = 'completed';
    await zoomMeeting.save();

    console.log(`✅ Recording URL added to meeting ${meetingId}`);

    res.json({
      success: true,
      message: 'Recording URL added successfully',
      zoomMeeting: zoomMeeting,
    });
  } catch (error) {
    console.error('❌ Error adding recording URL:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to add recording URL',
    });
  }
});

// Get Zoom meeting statistics
router.get('/admin/zoom/:meetingId/stats', isAdmin, getZoomMeetingStats);

// Delete Zoom meeting
router.delete('/admin/zoom/:meetingId', isAdmin, deleteZoomMeeting);

// ==================== STUDENT ROUTES ====================

// Debug endpoint to check Zoom configuration
router.get('/debug/config', (req, res) => {
  res.json({
    hasClientId: !!process.env.ZOOM_CLIENT_ID,
    hasClientSecret: !!process.env.ZOOM_CLIENT_SECRET,
    hasAccountId: !!process.env.ZOOM_ACCOUNT_ID,
    hasUserIds: !!(process.env.ZOOM_USER_IDS || process.env.ZOOM_USER_ID),
    userIds: process.env.ZOOM_USER_IDS
      ? process.env.ZOOM_USER_IDS.split(',').map((s) => s.trim())
      : process.env.ZOOM_USER_ID
      ? [process.env.ZOOM_USER_ID]
      : [],
    clientIdLength: process.env.ZOOM_CLIENT_ID
      ? process.env.ZOOM_CLIENT_ID.length
      : 0,
    appType: 'Server-to-Server OAuth',
    features: [
      'Meeting Creation',
      'Meeting Management',
      'Participant Reports',
      'Webhooks',
    ],
  });
});

// Join Zoom meeting (redirect to external client)
router.post('/student/zoom/:meetingId/join', isStudent, joinZoomMeeting);

// Record join attempt for analytics
router.post(
  '/student/zoom/:meetingId/join-attempt',
  isStudent,
  async (req, res) => {
    try {
      const { meetingId } = req.params;
      const studentId = req.session.user.id;

      // Record the join attempt
      await zoomService.recordAttendance(meetingId, studentId, 'join_attempt');

      res.json({ success: true, message: 'Join attempt recorded' });
    } catch (error) {
      // Error recording join attempt
      res
        .status(500)
        .json({ success: false, message: 'Failed to record join attempt' });
    }
  }
);

// Leave Zoom meeting (record attendance)
router.post('/student/zoom/:meetingId/leave', isStudent, leaveZoomMeeting);

// Mark recording as watched
router.post(
  '/student/zoom/:meetingId/mark-recording-watched',
  isStudent,
  async (req, res) => {
    try {
      const { meetingId } = req.params;
      const studentId = req.session.user.id;

      const ZoomMeeting = require('../models/ZoomMeeting');
      const User = require('../models/User');
      const Topic = require('../models/Topic');
      
      const zoomMeeting = await ZoomMeeting.findById(meetingId)
        .populate('course')
        .populate('topic');

      if (!zoomMeeting) {
        return res.status(404).json({
          success: false,
          message: 'Zoom meeting not found',
        });
      }

      const student = await User.findById(studentId);
      if (!student) {
        return res.status(404).json({
          success: false,
          message: 'Student not found',
        });
      }

      // Check if student already watched the recording
      const alreadyWatched = zoomMeeting.studentsWatchedRecording.some(
        (record) => record.student.toString() === studentId
      );

      if (!alreadyWatched) {
        // Add student to watched recording list
        zoomMeeting.studentsWatchedRecording.push({
          student: studentId,
          watchedAt: new Date(),
          completedWatching: true,
          watchDuration: zoomMeeting.duration || 0,
        });

        await zoomMeeting.save();
      }

      // Auto-mark content as completed when recording is watched
      try {
        // Get course and topic IDs (handle both populated and non-populated)
        const courseId = zoomMeeting.course._id || zoomMeeting.course;
        const topicId = zoomMeeting.topic._id || zoomMeeting.topic;
        
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
      } catch (progressError) {
        // Don't fail the request if progress update fails
      }

      res.json({
        success: true,
        message: 'Recording marked as watched and content marked as completed',
      });
    } catch (error) {
      // Error marking recording as watched
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to mark recording as watched',
      });
    }
  }
);

// Get student's Zoom meeting history
router.get('/student/zoom/history', isStudent, getZoomMeetingHistory);

// ==================== ZOOM WEBHOOK ROUTES ====================

/**
 * Zoom webhook endpoint for receiving meeting events
 * This endpoint handles:
 * - endpoint.url_validation (for webhook URL validation)
 * - meeting.started
 * - meeting.ended
 * - meeting.participant_joined
 * - meeting.participant_left
 * - recording.completed
 */
router.post('/webhook', async (req, res) => {
  try {
    const { event, payload } = req.body;

    console.log('🎯 Zoom webhook received:', event);

    // Handle URL validation challenge from Zoom
    if (event === 'endpoint.url_validation') {
      const plainToken = payload?.plainToken;

      if (!plainToken) {
        console.error('❌ Missing plainToken in validation request');
        return res.status(400).json({
          error: 'Missing plainToken in validation payload',
        });
      }

      // Get webhook secret token from environment
      const webhookSecret = process.env.ZOOM_Token;

      if (!webhookSecret) {
        console.error(
          '❌ ZOOM_WEBHOOK_SECRET_TOKEN or ZOOM_WEBHOOK_SECRET not set in environment'
        );
        return res.status(500).json({
          error: 'Webhook secret not configured',
        });
      }

      // Generate encrypted token using HMAC SHA-256
      const encryptedToken = crypto
        .createHmac('sha256', webhookSecret)
        .update(plainToken)
        .digest('hex');

      console.log('✅ URL validation response sent');

      // Return both tokens for Zoom to verify
      return res.status(200).json({
        plainToken: plainToken,
        encryptedToken: encryptedToken,
      });
    }

    // Process other webhook events
    await zoomService.processWebhook(event, payload);

    // Respond with 200 to acknowledge receipt
    res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('❌ Webhook processing error:', error);
    // Still return 200 to prevent Zoom from retrying
    res.status(200).json({ status: 'error', message: error.message });
  }
});

/**
 * Zoom webhook validation endpoint
 * Zoom sends a validation request when setting up webhooks
 */
router.get('/webhook', (req, res) => {
  res.status(200).send('Zoom webhook endpoint is active');
});

// ==================== UTILITY ROUTES ====================

/**
 * Get meeting report and statistics
 * Used for admin dashboards and analytics
 */
router.get('/admin/zoom/:meetingId/report', isAdmin, async (req, res) => {
  try {
    const { meetingId } = req.params;

    const report = await zoomService.getComprehensiveMeetingReport(meetingId);

    res.json({
      success: true,
      report: report,
    });
  } catch (error) {
    console.error('❌ Report generation error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate meeting report',
    });
  }
});

// ==================== YOUTUBE OAUTH ROUTES ====================

const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
];

/**
 * Initiate YouTube OAuth flow - redirects to Google for authorization
 * GET /zoom/admin/youtube/oauth
 */
router.get('/admin/youtube/oauth', isAdmin, (req, res) => {
  try {
    const clientId = process.env.YOUTUBE_CLIENT_ID;
    const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const redirectUri = process.env.YOUTUBE_REDIRECT_URI || `${baseUrl}/zoom/admin/youtube/oauth/callback`;

    if (!clientId || !clientSecret) {
      return res.status(400).send(`
        <h2>YouTube OAuth not configured</h2>
        <p>Please set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in your .env file.</p>
        <p>Get these from <a href="https://console.cloud.google.com/">Google Cloud Console</a> → APIs & Services → Credentials.</p>
      `);
    }

    console.log('🔗 YouTube OAuth redirect URI being sent to Google:', redirectUri);

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: YOUTUBE_SCOPES,
      prompt: 'consent', // Force consent to ensure we get refresh token
    });

    res.redirect(authUrl);
  } catch (error) {
    console.error('❌ YouTube OAuth initiation error:', error);
    res.status(500).send(`<h2>Error</h2><p>${error.message}</p>`);
  }
});

/**
 * YouTube OAuth callback - exchanges code for tokens, displays refresh token
 * GET /zoom/admin/youtube/oauth/callback
 */
router.get('/admin/youtube/oauth/callback', isAdmin, async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) {
      return res.status(400).send(`
        <h2>Authorization failed</h2>
        <p>No authorization code received. Please try again.</p>
        <p><a href="/zoom/admin/youtube/oauth">Retry OAuth</a></p>
      `);
    }

    const clientId = process.env.YOUTUBE_CLIENT_ID;
    const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const redirectUri = process.env.YOUTUBE_REDIRECT_URI || `${baseUrl}/zoom/admin/youtube/oauth/callback`;

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      return res.status(400).send(`
        <h2>No refresh token received</h2>
        <p>Google did not return a refresh token. This can happen if you've already authorized this app.</p>
        <p>Try revoking access at <a href="https://myaccount.google.com/permissions">Google Account Permissions</a> and try again.</p>
        <p><a href="/zoom/admin/youtube/oauth">Retry OAuth</a></p>
      `);
    }

    console.log('✅ YouTube OAuth success - refresh token obtained');

    res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>YouTube Connected</title></head>
      <body style="font-family: system-ui; max-width: 600px; margin: 40px auto; padding: 20px;">
        <h2>✅ YouTube OAuth Successful</h2>
        <p>Add this to your <code>.env</code> file:</p>
        <pre style="background: #f5f5f5; padding: 16px; overflow-x: auto;">YOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}</pre>
        <p>Also set:</p>
        <pre style="background: #f5f5f5; padding: 16px;">YOUTUBE_UPLOAD_ENABLED=true
RECORDING_UPLOAD_DESTINATION=youtube</pre>
        <p>Then restart your server. Zoom recordings will upload to YouTube after meetings end.</p>
      </body>
      </html>
    `);
  } catch (error) {
    console.error('❌ YouTube OAuth callback error:', error);
    res.status(500).send(`<h2>OAuth Error</h2><p>${error.message}</p>`);
  }
});

/**
 * Check YouTube configuration status
 * GET /zoom/admin/youtube/status
 */
router.get('/admin/youtube/status', isAdmin, (req, res) => {
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI || `${baseUrl}/zoom/admin/youtube/oauth/callback`;
  res.json({
    configured: youtubeService.isConfigured(),
    hasClientId: !!process.env.YOUTUBE_CLIENT_ID,
    hasClientSecret: !!process.env.YOUTUBE_CLIENT_SECRET,
    hasRefreshToken: !!process.env.YOUTUBE_REFRESH_TOKEN,
    uploadEnabled: process.env.YOUTUBE_UPLOAD_ENABLED === 'true',
    destination: process.env.RECORDING_UPLOAD_DESTINATION || 'auto',
    redirectUriUsed: redirectUri,
    redirectUriFromEnv: process.env.YOUTUBE_REDIRECT_URI || '(not set)',
  });
});

module.exports = router;
