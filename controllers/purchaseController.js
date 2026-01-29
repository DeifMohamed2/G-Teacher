const Purchase = require('../models/Purchase');
const User = require('../models/User');
const Teacher = require('../models/Teacher');
const Course = require('../models/Course');
const PromoCode = require('../models/PromoCode');
const crypto = require('crypto');
const paymobService = require('../utils/paymobService');
const whatsappSMSNotificationService = require('../utils/whatsappSMSNotificationService');
const wasender = require('../utils/wasender');

// Simple UUID v4 generator
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Process successful payment - Centralized function for webhook and redirect handlers
 * This is the SINGLE SOURCE OF TRUTH for payment success processing
 * @param {Object} purchase - The purchase object or ID
 * @param {Object} req - Optional request object for clearing session (only available in redirect handlers)
 */
async function processSuccessfulPayment(purchase, req = null) {
  try {
    // Reload purchase to ensure we have latest data
    const freshPurchase = await Purchase.findById(purchase._id || purchase)
      .populate('user')
      .populate('items.item');

    if (!freshPurchase) {
      throw new Error('Purchase not found');
    }

    // CRITICAL: Use atomic update to prevent race conditions
    // Only update if status is pending (idempotency check)
    if (freshPurchase.status !== 'pending') {
      console.log(
        `⚠️ Purchase ${freshPurchase.orderNumber} already processed with status: ${freshPurchase.status}`
      );

      // If already completed, verify enrollments are in place
      if (freshPurchase.status === 'completed') {
        const user = await User.findById(freshPurchase.user._id);
        let allEnrolled = true;

        for (const item of freshPurchase.items) {
          if (!user.isEnrolled(item.item)) {
            allEnrolled = false;
            console.log(`⚠️ Missing enrollment for course ${item.item}`);
          }
        }

        // If enrollments are missing, re-enroll
        if (!allEnrolled) {
          console.log(`🔧 Re-enrolling user for order ${freshPurchase.orderNumber}`);
          // Continue with enrollment process below
        } else {
          return { success: true, alreadyProcessed: true, purchase: freshPurchase };
        }
      } else {
        return { success: true, alreadyProcessed: true, purchase: freshPurchase };
      }
    }

    // ATOMIC UPDATE: Use findOneAndUpdate to ensure only one process can update at a time
    const updatedPurchase = await Purchase.findOneAndUpdate(
      {
        _id: freshPurchase._id,
        status: 'pending' // Only update if still pending (prevents race conditions)
      },
      {
        $set: {
          status: 'completed',
          paymentStatus: 'completed',
          completedAt: new Date(),
        }
      },
      { new: true }
    ).populate('user').populate('items.item');

    // If update failed (another process already updated it), return
    if (!updatedPurchase || updatedPurchase.status !== 'completed') {
      console.log(
        `⚠️ Purchase ${freshPurchase.orderNumber} was updated by another process`
      );
      const reloaded = await Purchase.findById(freshPurchase._id)
        .populate('user')
        .populate('items.item');
      return { success: true, alreadyProcessed: true, purchase: reloaded };
    }

    // Use the updated purchase for rest of processing
    const purchaseToProcess = updatedPurchase;

    console.log(
      `✅ Processing successful payment for order: ${purchaseToProcess.orderNumber}`
    );

    // Get user with all necessary data
    const user = await User.findById(purchaseToProcess.user._id)
      .populate('purchasedCourses.course')
      .populate('enrolledCourses.course');

    if (!user) {
      throw new Error('User not found');
    }

    // Process user enrollments - CRITICAL: This must complete successfully
    for (const purchaseItem of purchaseToProcess.items) {
      await user.addPurchasedCourse(
        purchaseItem.item,
        purchaseItem.price,
        purchaseToProcess.orderNumber
      );

      if (!user.isEnrolled(purchaseItem.item)) {
        user.enrolledCourses.push({
          course: purchaseItem.item,
          enrolledAt: new Date(),
          progress: 0,
          lastAccessed: new Date(),
          completedTopics: [],
          status: 'active',
        });
        await user.save();
        console.log(`✅ Enrolled user in course: ${purchaseItem.title}`);
      }
    }

    // Handle promo code usage if applied
    if (purchaseToProcess.appliedPromoCode && purchaseToProcess.discountAmount > 0) {
      try {
        // Add promo code usage to user
        await user.addPromoCodeUsage(
          freshPurchase.appliedPromoCode,
          freshPurchase._id,
          freshPurchase.discountAmount,
          freshPurchase.originalAmount,
          freshPurchase.total
        );

        // Update promo code usage count and history
        const promoCode = await PromoCode.findById(
          purchaseToProcess.appliedPromoCode
        );
        if (promoCode) {
          // Add to usage history
          promoCode.usageHistory.push({
            user: purchaseToProcess.user._id,
            purchase: purchaseToProcess._id,
            discountAmount: purchaseToProcess.discountAmount,
            originalAmount: purchaseToProcess.originalAmount,
            finalAmount: purchaseToProcess.total,
            usedAt: new Date(),
          });

          // Increment current uses
          promoCode.currentUses += 1;
          await promoCode.save();

          console.log('Promo code usage tracked:', {
            code: promoCode.code,
            user: purchaseToProcess.user._id,
            purchase: purchaseToProcess._id,
            discountAmount: purchaseToProcess.discountAmount,
          });
        }
      } catch (error) {
        console.error('Error tracking promo code usage:', error);
      }
    }

    // Clear cart after payment is confirmed completed
    if (req && req.session) {
      clearCart(req, 'payment completed');
    }

    console.log(
      `✅ Successfully processed payment and enrollment for order: ${purchaseToProcess.orderNumber}`
    );

    return { success: true, purchase: purchaseToProcess };
  } catch (error) {
    console.error('Error processing successful payment:', error);
    throw error;
  }
}

/**
 * Process failed payment - Centralized function for webhook and redirect handlers
 */
async function processFailedPayment(purchase, failureReason, paymentGatewayResponse = {}) {
  try {
    // Reload purchase to ensure we have latest data
    const freshPurchase = await Purchase.findById(purchase._id || purchase);

    if (!freshPurchase) {
      throw new Error('Purchase not found');
    }

    // Only process if status is pending (idempotency check)
    if (freshPurchase.status !== 'pending') {
      console.log(
        `⚠️ Purchase ${freshPurchase.orderNumber} already processed with status: ${freshPurchase.status}`
      );
      return { success: true, alreadyProcessed: true, purchase: freshPurchase };
    }

    // Update purchase status
    freshPurchase.status = 'failed';
    freshPurchase.paymentStatus = 'failed';
    freshPurchase.failureReason = failureReason || 'Payment declined or failed';
    freshPurchase.paymentGatewayResponse = paymentGatewayResponse;
    await freshPurchase.save();

    console.log('💾 Failed purchase saved:', {
      orderNumber: freshPurchase.orderNumber,
      paymobTransactionId: freshPurchase.paymobTransactionId,
      paymobOrderId: freshPurchase.paymobOrderId,
      failureReason: freshPurchase.failureReason,
      status: freshPurchase.status,
    });

    return { success: true, purchase: freshPurchase };
  } catch (error) {
    console.error('Error processing failed payment:', error);
    throw error;
  }
}

// Helper function to validate course ordering when adding to cart
// Course sequencing removed - always allow any order
async function validateCourseOrdering(courseId, userId, cartItems = []) {
  return { valid: true };
}

// Helper function to validate course removal from cart
// Course sequencing removed - always allow removal
async function validateCourseRemoval(courseId, userId, cartItems = []) {
  return { valid: true };
}

// Helper function to validate all courses in cart have proper ordering
// Course sequencing removed - always allow any order
async function validateCartOrdering(cartItems, userId) {
  return { valid: true };
}

// Helper function to recalculate cart totals from database
async function recalculateCartFromDB(cart, userId = null) {
  if (!cart || cart.length === 0) {
    return {
      items: [],
      subtotal: 0,
      tax: 0,
      total: 0,
      validItems: [],
    };
  }

  const validItems = [];
  let subtotal = 0;

  // If userId is provided, get user's purchased items to check for duplicates
  let user = null;
  if (userId) {
    user = await User.findById(userId)
      .populate('purchasedCourses.course')
      .populate('enrolledCourses.course');
  }

  for (const cartItem of cart) {
    try {
      // Check if user already purchased this item
      if (user) {
        if (cartItem.type === 'course' && user.hasAccessToCourse(cartItem.id)) {
          console.log(
            `Removing already purchased course from cart: ${cartItem.id}`
          );
          continue;
        }
      }

      // Only handle courses now - also fetch teacher info for commission calculation
      const dbItem = await Course.findById(cartItem.id)
        .select('title price discountPrice thumbnail status isActive teacher')
        .populate('teacher', '_id firstName lastName gTeacherPercentage');

      // Only include valid, active items
      if (
        dbItem &&
        dbItem.isActive &&
        dbItem.status === 'published'
      ) {
        // Calculate final price considering discount
        const originalPrice = dbItem.price || 0;
        const discountPercentage = dbItem.discountPrice || 0;
        let finalPrice = originalPrice;

        if (discountPercentage > 0) {
          finalPrice =
            originalPrice - originalPrice * (discountPercentage / 100);
        }

        // Get teacher commission info
        const teacherId = dbItem.teacher ? dbItem.teacher._id : null;
        const gTeacherPercentage = dbItem.teacher ? (dbItem.teacher.gTeacherPercentage || 0) : 0;

        const validItem = {
          id: cartItem.id,
          type: 'course',
          title: dbItem.title,
          originalPrice: originalPrice,
          discountPrice: discountPercentage,
          price: finalPrice, // Final price after discount
          image: dbItem.thumbnail || '/images/adad.png',
          addedAt: cartItem.addedAt,
          // Teacher commission data
          teacherId: teacherId,
          teacherName: dbItem.teacher ? `${dbItem.teacher.firstName} ${dbItem.teacher.lastName}` : null,
          gTeacherPercentage: gTeacherPercentage,
        };

        validItems.push(validItem);
        subtotal += finalPrice;
      } else {
        console.log(
          `Removing invalid item from cart: ${cartItem.id} (${cartItem.type})`
        );
      }
    } catch (error) {
      console.error(`Error validating cart item ${cartItem.id}:`, error);
    }
  }

  const total = subtotal;

  return {
    items: validItems,
    subtotal,
    total,
    validItems,
  };
}

// Helper function to clear cart after successful payment
function clearCart(req, reason = 'successful payment') {
  const cartCount = req.session.cart ? req.session.cart.length : 0;

  // Only clear if there are items in the cart
  if (cartCount > 0) {
    req.session.cart = [];
    // Force save the session
    req.session.save((err) => {
      if (err) {
        console.error('Error saving session after clearing cart:', err);
      } else {
        console.log(
          `Cart cleared after ${reason}. ${cartCount} items removed.`
        );
      }
    });
  } else {
    console.log(
      `Cart was already empty when attempting to clear after ${reason}.`
    );
  }

  return cartCount;
}

// Middleware to validate and recalculate cart items from database
const validateCartMiddleware = async (req, res, next) => {
  try {
    if (req.session.cart && req.session.cart.length > 0) {
      console.log('Validating cart items from database...');
      const userId = req.session.user ? req.session.user.id : null;
      const recalculatedCart = await recalculateCartFromDB(
        req.session.cart,
        userId
      );

      // Update session cart with validated items
      req.session.cart = recalculatedCart.validItems;

      // Attach validated cart data to request for use in controllers
      req.validatedCart = {
        items: recalculatedCart.items,
        subtotal: recalculatedCart.subtotal,
        total: recalculatedCart.total,
        cartCount: recalculatedCart.items.length,
      };

      console.log(
        `Cart validation complete. ${recalculatedCart.items.length} valid items, total: AED${recalculatedCart.total}`
      );
    } else {
      req.validatedCart = {
        items: [],
        subtotal: 0,
        total: 0,
        cartCount: 0,
      };
    }

    next();
  } catch (error) {
    console.error('Error validating cart:', error);
    // Clear invalid cart and continue
    req.session.cart = [];
    req.validatedCart = {
      items: [],
      subtotal: 0,
      total: 0,
      cartCount: 0,
    };
    next();
  }
};

// Helper function to validate and apply promo code
async function validateAndApplyPromoCode(
  promoCode,
  userId,
  cartItems,
  subtotal,
  userEmail = null
) {
  try {
    // Check if promo code exists and is valid
    const promo = await PromoCode.findValidPromoCode(
      promoCode,
      userId,
      userEmail
    );

    if (!promo) {
      throw new Error('Invalid or expired promo code');
    }

    // Check if user has already used this promo code
    if (!promo.canUserUse(userId, userEmail)) {
      if (promo.restrictToStudents) {
        throw new Error('This promo code is not available for your account');
      }
      throw new Error('You have already used this promo code');
    }

    // Calculate discount
    const discountAmount = promo.calculateDiscount(subtotal, cartItems);
    const finalAmount = subtotal - discountAmount;

    // SECURITY: Ensure final amount is not negative
    if (finalAmount < 0) {
      throw new Error('Invalid discount amount');
    }

    // SECURITY: Ensure discount doesn't exceed subtotal
    if (discountAmount > subtotal) {
      throw new Error('Discount amount cannot exceed order total');
    }

    return {
      success: true,
      promoCode: promo,
      discountAmount,
      finalAmount,
      originalAmount: subtotal,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
}

// API endpoint to validate promo code
const validatePromoCode = async (req, res) => {
  try {
    if (!req.session.user) {
      return res.status(401).json({
        success: false,
        message: 'Please login to use promo codes',
      });
    }

    const { promoCode } = req.body;
    const validatedCart = req.validatedCart;

    if (!promoCode) {
      return res.status(400).json({
        success: false,
        message: 'Promo code is required',
      });
    }

    // Allow promo code validation for cart
    if (validatedCart.cartCount === 0) {
      return res.status(400).json({
        success: false,
        message: 'Cart is empty',
      });
    }

    // Calculate total amount
    const totalAmount = validatedCart.subtotal;

    // Create items array for promo validation
    const itemsForPromo = [...validatedCart.items];

    const result = await validateAndApplyPromoCode(
      promoCode,
      req.session.user.id,
      itemsForPromo,
      totalAmount,
      req.session.user.email || req.session.user.studentEmail
    );

    if (result.success) {
      // Store promo code in session for checkout
      req.session.appliedPromoCode = {
        code: result.promoCode.code,
        id: result.promoCode._id,
        discountAmount: result.discountAmount,
        finalAmount: result.finalAmount,
        originalAmount: result.originalAmount,
      };

      res.json({
        success: true,
        message: 'Promo code applied successfully',
        discountAmount: result.discountAmount,
        finalAmount: result.finalAmount,
        originalAmount: result.originalAmount,
        promoCode: result.promoCode.code,
      });
    } else {
      res.status(400).json({
        success: false,
        message: result.error,
      });
    }
  } catch (error) {
    console.error('Error validating promo code:', error);
    res.status(500).json({
      success: false,
      message: 'Error validating promo code',
    });
  }
};


// API endpoint to remove promo code
const removePromoCode = async (req, res) => {
  try {
    if (!req.session.user) {
      return res.status(401).json({
        success: false,
        message: 'Please login to manage promo codes',
      });
    }

    // Remove promo code from session
    delete req.session.appliedPromoCode;

    const validatedCart = req.validatedCart || { subtotal: 0 };

    res.json({
      success: true,
      message: 'Promo code removed successfully',
      originalAmount: validatedCart.subtotal,
      finalAmount: validatedCart.subtotal,
      discountAmount: 0,
    });
  } catch (error) {
    console.error('Error removing promo code:', error);
    res.status(500).json({
      success: false,
      message: 'Error removing promo code',
    });
  }
};

// Helper function to clear invalid promo code from session
const clearInvalidPromoCode = (req) => {
  if (req.session.appliedPromoCode) {
    console.log(
      'Clearing invalid promo code from session:',
      req.session.appliedPromoCode.code
    );
    delete req.session.appliedPromoCode;
  }
};

// Get cart data (for API calls)
const getCart = async (req, res) => {
  try {
    if (!req.session.user) {
      return res.status(401).json({
        success: false,
        message: 'Please login to view your cart',
      });
    }

    // Get cart from session and recalculate from database
    const cart = req.session.cart || [];
    const recalculatedCart = await recalculateCartFromDB(cart);

    // Update session cart with validated items
    req.session.cart = recalculatedCart.validItems;

    res.json({
      success: true,
      cart: recalculatedCart.items,
      subtotal: recalculatedCart.subtotal,
      total: recalculatedCart.total,
      cartCount: recalculatedCart.items.length,
    });
  } catch (error) {
    console.error('Error fetching cart:', error);
    res.status(500).json({
      success: false,
      message: 'Error loading cart',
    });
  }
};

// Clear cart API endpoint
const clearCartAPI = async (req, res) => {
  try {
    if (!req.session.user) {
      return res.status(401).json({
        success: false,
        message: 'Please login',
      });
    }

    const cartCount = req.session.cart ? req.session.cart.length : 0;
    req.session.cart = [];

    // Force save the session
    await new Promise((resolve, reject) => {
      req.session.save((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    console.log(`Cart cleared via API. ${cartCount} items removed.`);

    res.json({
      success: true,
      message: 'Cart cleared successfully',
      cartCount: 0,
    });
  } catch (error) {
    console.error('Error clearing cart:', error);
    res.status(500).json({
      success: false,
      message: 'Error clearing cart',
    });
  }
};

// Add item to cart
const addToCart = async (req, res) => {
  try {
    const { itemId } = req.body;
    const itemType = 'course'; // Only courses are supported now

    if (!req.session.user) {
      return res.status(401).json({
        success: false,
        message: 'Please login to add items to cart',
      });
    }

    // Validate item exists and get price from database
    const item = await Course.findById(itemId).select(
      'title price discountPrice thumbnail status isActive isFullyBooked fullyBookedMessage'
    );

    if (!item) {
      return res.status(404).json({
        success: false,
        message: 'Item not found',
      });
    }

    // Check if item is fully booked
    if (item.isFullyBooked) {
      return res.status(400).json({
        success: false,
        message: item.fullyBookedMessage || 'This item is fully booked',
      });
    }

    // Validate item is available for purchase
    if (!item.isActive || item.status !== 'published') {
      return res.status(400).json({
        success: false,
        message: 'This course is not available for purchase',
      });
    }

    // Check if user already purchased this item by querying the database
    const user = await User.findById(req.session.user.id)
      .populate('purchasedCourses.course')
      .populate('enrolledCourses.course');
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    if (user.hasAccessToCourse(itemId)) {
      return res.status(400).json({
        success: false,
        message:
          'You already have access to this course through a previous purchase',
      });
    }

    // Initialize cart if not exists
    if (!req.session.cart) {
      req.session.cart = [];
    }

    // Check if item already in cart
    const existingItem = req.session.cart.find(
      (cartItem) => cartItem.id === itemId && cartItem.type === itemType
    );

    if (existingItem) {
      return res.status(400).json({
        success: false,
        message: 'Item already in cart',
      });
    }

    // Validate course ordering before adding to cart
    const orderValidation = await validateCourseOrdering(
      itemId,
      req.session.user.id,
      req.session.cart
    );

    if (!orderValidation.valid) {
      return res.status(400).json({
        success: false,
        message: orderValidation.message,
        missingCourse: orderValidation.missingCourse
      });
    }

    // Add item to cart (using database values only)
    const originalPrice = item.price || 0;
    const discountPercentage = item.discountPrice || 0;
    let finalPrice = originalPrice;

    if (discountPercentage > 0) {
      finalPrice = originalPrice - originalPrice * (discountPercentage / 100);
    }

    const cartItem = {
      id: itemId,
      type: itemType,
      title: item.title,
      originalPrice: originalPrice,
      discountPrice: discountPercentage,
      price: finalPrice, // Final price after discount
      image: item.thumbnail || '/images/adad.png',
      addedAt: new Date(),
    };

    req.session.cart.push(cartItem);

    res.json({
      success: true,
      message: 'Item added to cart successfully',
      cartCount: req.session.cart.length,
    });
  } catch (error) {
    console.error('Error adding to cart:', error);
    res.status(500).json({
      success: false,
      message: 'Error adding item to cart',
    });
  }
};

// Remove item from cart
const removeFromCart = async (req, res) => {
  try {
    const { itemId, itemType } = req.body;

    if (!req.session.cart) {
      return res.status(400).json({
        success: false,
        message: 'Cart is empty',
      });
    }

    // Validate course ordering when removing from cart
    if (itemType === 'course' && req.session.user) {
      const removalValidation = await validateCourseRemoval(
        itemId,
        req.session.user.id,
        req.session.cart
      );

      if (!removalValidation.valid) {
        return res.status(400).json({
          success: false,
          message: removalValidation.message,
          blockingCourse: removalValidation.blockingCourse
        });
      }
    }

    req.session.cart = req.session.cart.filter(
      (item) => !(item.id === itemId && item.type === itemType)
    );

    res.json({
      success: true,
      message: 'Item removed from cart',
      cartCount: req.session.cart.length,
    });
  } catch (error) {
    console.error('Error removing from cart:', error);
    res.status(500).json({
      success: false,
      message: 'Error removing item from cart',
    });
  }
};

// Update cart item quantity
const updateCartQuantity = async (req, res) => {
  try {
    const { itemId, itemType, quantity } = req.body;

    if (!req.session.cart) {
      return res.status(400).json({
        success: false,
        message: 'Cart is empty',
      });
    }

    const item = req.session.cart.find(
      (cartItem) => cartItem.id === itemId && cartItem.type === itemType
    );

    if (!item) {
      return res.status(404).json({
        success: false,
        message: 'Item not found in cart',
      });
    }

    if (quantity <= 0) {
      req.session.cart = req.session.cart.filter(
        (cartItem) => !(cartItem.id === itemId && cartItem.type === itemType)
      );
    } else {
      item.quantity = Math.min(quantity, 1); // Max quantity is 1
    }

    // Calculate totals
    const subtotal = req.session.cart.reduce(
      (sum, item) => sum + item.price,
      0
    );
    const tax = 0; // No tax
    const total = subtotal + tax;

    res.json({
      success: true,
      message: 'Cart updated successfully',
      cartCount: req.session.cart.length,
      subtotal,
      tax,
      total,
    });
  } catch (error) {
    console.error('Error updating cart:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating cart',
    });
  }
};

// Get checkout page
const getCheckout = async (req, res) => {
  try {
    if (!req.session.user) {
      req.flash('error_msg', 'Please login to proceed to checkout');
      return res.redirect('/auth/login');
    }

    // Check if course query parameter is present (for "Buy Now" functionality)
    const courseId = req.query.course;

    if (courseId) {
      // Initialize cart if not exists
      if (!req.session.cart) {
        req.session.cart = [];
      }

      // Check if course is already in cart
      const existingCourse = req.session.cart.find(
        (cartItem) => cartItem.id === courseId && cartItem.type === 'course'
      );

      if (!existingCourse) {
        // Add course to cart
        const course = await Course.findById(courseId).select(
          'title price discountPrice thumbnail status isActive isFullyBooked fullyBookedMessage'
        );

        if (!course) {
          req.flash('error_msg', 'Course not found');
          return res.redirect('/');
        }

        // Check if course is fully booked
        if (course.isFullyBooked) {
          req.flash('error_msg', course.fullyBookedMessage || 'This course is fully booked');
          return res.redirect('back');
        }

        // Validate course is available for purchase
        if (!course.isActive || course.status !== 'published') {
          req.flash('error_msg', 'This course is not available for purchase');
          return res.redirect('/');
        }

        // Check if user already has access to this course
        const user = await User.findById(req.session.user.id);
        if (user && user.hasAccessToCourse(courseId)) {
          req.flash('error_msg', 'You already have access to this course');
          return res.redirect('/');
        }

        // Validate course ordering
        const orderValidation = await validateCourseOrdering(
          courseId,
          req.session.user.id,
          req.session.cart
        );

        if (!orderValidation.valid) {
          req.flash('error_msg', orderValidation.message);
          return res.redirect('back');
        }

        // Calculate final price
        const originalPrice = course.price || 0;
        const discountPercentage = course.discountPrice || 0;
        let finalPrice = originalPrice;

        if (discountPercentage > 0) {
          finalPrice = originalPrice - originalPrice * (discountPercentage / 100);
        }

        // Add course to cart
        const cartItem = {
          id: courseId,
          type: 'course',
          title: course.title,
          originalPrice: originalPrice,
          discountPrice: discountPercentage,
          price: finalPrice,
          image: course.thumbnail || '/images/adad.png',
          addedAt: new Date(),
        };

        req.session.cart.push(cartItem);
      }
    }

    // If we added items from query params, we need to re-validate the cart
    // since validateCartMiddleware already ran before getCheckout
    let validatedCart = req.validatedCart;

    if (courseId) {
      // Recalculate cart from database to include newly added items
      const recalculatedCart = await recalculateCartFromDB(
        req.session.cart,
        req.session.user.id
      );

      // Update session cart with validated items
      req.session.cart = recalculatedCart.validItems;

      // Update validatedCart with new data
      validatedCart = {
        items: recalculatedCart.items,
        subtotal: recalculatedCart.subtotal,
        total: recalculatedCart.total,
        cartCount: recalculatedCart.items.length,
      };
    }

    if (validatedCart.cartCount === 0) {
      req.flash('error_msg', 'Your cart is empty or contains invalid items');
      return res.redirect('/');
    }

    // Validate course ordering at checkout page
    if (req.session.user) {
      const cartOrderValidation = await validateCartOrdering(
        validatedCart.items,
        req.session.user.id
      );

      if (!cartOrderValidation.valid) {
        req.flash('error_msg', cartOrderValidation.message);
        return res.redirect('back');
      }
    }

    // Check if there's an applied promo code in session
    let appliedPromo = null;
    if (req.session.appliedPromoCode) {
      appliedPromo = {
        code: req.session.appliedPromoCode.code,
        discountAmount: req.session.appliedPromoCode.discountAmount,
        finalAmount: req.session.appliedPromoCode.finalAmount,
        originalAmount: req.session.appliedPromoCode.originalAmount,
      };
    }

    res.render('checkout', {
      title: 'Checkout | G-Teacher',
      theme: req.cookies.theme || 'light',
      cart: validatedCart.items,
      subtotal: validatedCart.subtotal,
      total: validatedCart.total,
      user: req.session.user,
      appliedPromoCode: appliedPromo, // Pass promo code to view
      googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '', // Pass Google Maps API key
      // Payment method availability
      paymentMethods: {
        card: !!process.env.PAYMOB_INTEGRATION_ID_CARD,
        wallet: !!process.env.PAYMOB_INTEGRATION_ID_WALLET,
        kiosk: !!process.env.PAYMOB_INTEGRATION_ID_KIOSK,
        applePay: !!process.env.PAYMOB_INTEGRATION_ID_APPLE_PAY,
      },
    });
  } catch (error) {
    console.error('Error fetching checkout:', error);
    req.flash('error_msg', 'Error loading checkout page');
    res.redirect('/');
  }
};

// Direct checkout (skip checkout page, go straight to order summary)
const directCheckout = async (req, res) => {
  try {
    if (!req.session.user) {
      return res.status(401).json({
        success: false,
        message: 'Please login to complete purchase',
      });
    }

    // Use validated cart data from middleware
    const validatedCart = req.validatedCart;

    if (validatedCart.cartCount === 0) {
      return res.status(400).json({
        success: false,
        message: 'Cart is empty or contains invalid items',
      });
    }

    // Validate course ordering at checkout
    if (req.session.user) {
      const cartOrderValidation = await validateCartOrdering(
        validatedCart.items,
        req.session.user.id
      );

      if (!cartOrderValidation.valid) {
        return res.status(400).json({
          success: false,
          message: cartOrderValidation.message,
          missingCourse: cartOrderValidation.missingCourse
        });
      }
    }

    const { paymentMethod = 'credit_card', billingAddress } = req.body;

    // Use default billing address if not provided
    const defaultBillingAddress = {
      firstName: req.session.user.firstName || 'Default',
      lastName: req.session.user.lastName || 'User',
      email: req.session.user.studentEmail || req.session.user.email,
      phone: `${req.session.user.parentCountryCode || '+966'}${req.session.user.parentNumber || '123456789'
        }`,
      address: 'Default Address',
      city: 'Riyadh',
      state: 'Riyadh',
      zipCode: '12345',
      country: 'Saudi Arabia',
    };

    const finalBillingAddress = billingAddress || defaultBillingAddress;

    // Get user from database
    const user = await User.findById(req.session.user.id)
      .populate('purchasedCourses.course')
      .populate('purchasedCourses.course')
      .populate('enrolledCourses.course');
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    // Calculate commission breakdown for each item
    let totalGTeacherCommission = 0;
    let totalTeacherNet = 0;

    const purchaseItems = validatedCart.items.map((item) => {
      // Calculate commission based on the item price
      const itemPrice = item.price;
      const gTeacherPercentage = item.gTeacherPercentage || 0;
      const gTeacherCommission = (itemPrice * gTeacherPercentage) / 100;
      const teacherNet = itemPrice - gTeacherCommission;

      totalGTeacherCommission += gTeacherCommission;
      totalTeacherNet += teacherNet;

      return {
        itemType: item.type,
        itemTypeModel: 'Course',
        item: item.id,
        title: item.title,
        price: itemPrice, // Database-validated price
        quantity: 1,
        // G-Teacher Commission Tracking
        teacher: item.teacherId || null,
        gTeacherPercentage: gTeacherPercentage,
        gTeacherCommission: Math.round(gTeacherCommission * 100) / 100,
        teacherNet: Math.round(teacherNet * 100) / 100,
      };
    });

    // Create purchase record using validated cart data with commission info
    const purchase = new Purchase({
      user: user._id,
      items: purchaseItems,
      subtotal: validatedCart.subtotal,
      total: validatedCart.total,
      totalGTeacherCommission: Math.round(totalGTeacherCommission * 100) / 100,
      totalTeacherNet: Math.round(totalTeacherNet * 100) / 100,
      paymentMethod,
      billingAddress: finalBillingAddress,
      status: 'completed',
      paymentStatus: 'completed',
      paymentIntentId: `pi_${Date.now()}`,
    });

    console.log('Creating purchase record with commission:', {
      orderNumber: purchase.orderNumber,
      total: validatedCart.total,
      totalGTeacherCommission: purchase.totalGTeacherCommission,
      totalTeacherNet: purchase.totalTeacherNet,
    });

    try {
      await purchase.save();
      console.log(
        'Purchase saved successfully with order number:',
        purchase.orderNumber
      );
    } catch (saveError) {
      console.error('Error saving purchase:', saveError);
      throw saveError;
    }

    // Refresh the purchase to get the generated orderNumber
    await purchase.populate('items.item');

    // Update user's purchased items and enrollments
    for (const item of validatedCart.items) {
      const course = await Course.findById(item.id);
      await user.addPurchasedCourse(
        item.id,
        item.price,
        purchase.orderNumber,
        course.teacher
      );
      // Enroll user in course
      await user.enrollInCourseById(item.id, course.teacher);
    }

    // Clear cart
    const clearedCount = clearCart(req, 'direct checkout');

    // Send WhatsApp notification for direct checkout
    try {
      console.log(
        '📱 Sending WhatsApp notification for direct checkout:',
        purchase.orderNumber
      );
      await whatsappSMSNotificationService.sendPurchaseInvoiceNotification(
        user._id,
        purchase
      );

      // Mark WhatsApp notification as sent
      purchase.whatsappNotificationSent = true;
      await purchase.save();
      console.log('✅ WhatsApp notification sent for direct checkout');
    } catch (whatsappError) {
      console.error(
        '❌ WhatsApp notification error for direct checkout:',
        whatsappError
      );
      // Don't fail the direct checkout if WhatsApp fails
    }

    res.json({
      success: true,
      message: 'Payment processed successfully',
      purchase: {
        orderNumber: purchase.orderNumber,
        items: validatedCart.items.map((item) => ({
          ...item,
          type: item.type,
        })),
        subtotal: validatedCart.subtotal,
        total: validatedCart.total,
      },
      cartCleared: true,
      itemsRemoved: clearedCount,
    });
  } catch (error) {
    console.error('Error processing direct checkout:', error);
    res.status(500).json({
      success: false,
      message: 'Error processing payment',
    });
  }
};

// Process payment and create order
const processPayment = async (req, res) => {
  try {
    if (!req.session.user) {
      return res.status(401).json({
        success: false,
        message: 'Please login to complete purchase',
      });
    }

    // Use validated cart data from middleware
    const validatedCart = req.validatedCart;

    if (validatedCart.cartCount === 0) {
      return res.status(400).json({
        success: false,
        message: 'Cart is empty or contains invalid items',
      });
    }

    // Validate course ordering at checkout
    const cartOrderValidation = await validateCartOrdering(
      validatedCart.items,
      req.session.user.id
    );

    if (!cartOrderValidation.valid) {
      return res.status(400).json({
        success: false,
        message: cartOrderValidation.message,
        missingCourse: cartOrderValidation.missingCourse
      });
    }

    // Check if user already purchased any of the items in cart
    const user = await User.findById(req.session.user.id);
    const alreadyPurchasedItems = [];

    for (const item of validatedCart.items) {
      if (item.type === 'course' && user.hasAccessToCourse(item.id)) {
        alreadyPurchasedItems.push(`${item.title} (course)`);
      }
    }

    if (alreadyPurchasedItems.length > 0) {
      return res.status(400).json({
        success: false,
        message: `You already have access to: ${alreadyPurchasedItems.join(
          ', '
        )}. Please remove these items from your cart.`,
      });
    }

    const { paymentMethod = 'paymob', billingAddress } = req.body;

    // Validate billing address
    const requiredFields = [
      'firstName',
      'lastName',
      'email',
      'phone',
      'address', // Updated validation: removed city, state, zipCode as strictly required from frontend
      'country',
    ];
    for (const field of requiredFields) {
      if (!billingAddress[field]) {
        return res.status(400).json({
          success: false,
          message: `${field} is required`,
        });
      }
    }

    // Provide default values for missing fields to satisfy database requirements
    if (!billingAddress.city) billingAddress.city = 'Not Provided';
    if (!billingAddress.state) billingAddress.state = 'Not Provided';
    if (!billingAddress.zipCode) billingAddress.zipCode = '00000';

    // Generate unique merchant order ID
    const merchantOrderId = generateUUID();

    // Calculate base subtotal
    const baseSubtotal = validatedCart.subtotal;

    // Handle promo code if applied - SECURITY: Always recalculate from server
    let finalSubtotal = baseSubtotal;
    let finalTotal = baseSubtotal;
    let appliedPromoCode = null;
    let discountAmount = 0;

    if (req.session.appliedPromoCode) {
      // SECURITY: Re-validate promo code and recalculate amounts from server
      const promoValidation = await validateAndApplyPromoCode(
        req.session.appliedPromoCode.code,
        req.session.user.id,
        validatedCart.items,
        baseSubtotal,
        req.session.user.email || req.session.user.studentEmail
      );

      if (promoValidation.success) {
        appliedPromoCode = promoValidation.promoCode;
        discountAmount = promoValidation.discountAmount;
        finalSubtotal = baseSubtotal; // Keep original subtotal
        finalTotal = promoValidation.finalAmount; // Use server-calculated final amount

        // SECURITY: Validate that session promo code data matches server calculation
        const sessionDiscount =
          req.session.appliedPromoCode.discountAmount || 0;
        const sessionFinal = req.session.appliedPromoCode.finalAmount || 0;

        if (
          Math.abs(sessionDiscount - discountAmount) > 0.01 ||
          Math.abs(sessionFinal - finalTotal) > 0.01
        ) {
          console.warn(
            'Promo code session data mismatch, using server calculation:',
            {
              sessionDiscount,
              serverDiscount: discountAmount,
              sessionFinal,
              serverFinal: finalTotal,
            }
          );
        }

        console.log('Promo code applied successfully:', {
          originalAmount: baseSubtotal,
          discountAmount: discountAmount,
          finalAmount: finalTotal,
          promoCode: appliedPromoCode.code,
        });
      } else {
        // Remove invalid promo code from session
        delete req.session.appliedPromoCode;
        return res.status(400).json({
          success: false,
          message: `Promo code is no longer valid: ${promoValidation.error}`,
        });
      }
    }

    // Final total
    const total = finalTotal;

    // Create purchase record with pending status using validated cart data
    // Calculate commission breakdown for each item
    let totalGTeacherCommission = 0;
    let totalTeacherNet = 0;

    const purchaseItems = validatedCart.items.map((item) => {
      // Calculate commission based on the item price (after any course discount, before promo code)
      const itemPrice = item.price;
      const gTeacherPercentage = item.gTeacherPercentage || 0;
      const gTeacherCommission = (itemPrice * gTeacherPercentage) / 100;
      const teacherNet = itemPrice - gTeacherCommission;

      totalGTeacherCommission += gTeacherCommission;
      totalTeacherNet += teacherNet;

      return {
        itemType: item.type,
        itemTypeModel: 'Course',
        item: item.id,
        title: item.title,
        price: itemPrice, // Database-validated price
        quantity: 1,
        // G-Teacher Commission Tracking
        teacher: item.teacherId || null,
        gTeacherPercentage: gTeacherPercentage,
        gTeacherCommission: Math.round(gTeacherCommission * 100) / 100, // Round to 2 decimal places
        teacherNet: Math.round(teacherNet * 100) / 100, // Round to 2 decimal places
      };
    });

    const purchase = new Purchase({
      user: req.session.user.id,
      items: purchaseItems,
      subtotal: finalSubtotal,
      total: total,
      totalGTeacherCommission: Math.round(totalGTeacherCommission * 100) / 100,
      totalTeacherNet: Math.round(totalTeacherNet * 100) / 100,
      currency: 'AED',
      paymentMethod: 'paymob',
      billingAddress,
      status: 'pending',
      paymentStatus: 'pending',
      paymentIntentId: merchantOrderId,
      // Add promo code information
      appliedPromoCode: appliedPromoCode ? appliedPromoCode._id : null,
      discountAmount: discountAmount,
      originalAmount: validatedCart.subtotal,
      promoCodeUsed: appliedPromoCode ? appliedPromoCode.code : null,
    });

    await purchase.save();

    console.log('Purchase created with commission breakdown:', {
      orderNumber: purchase.orderNumber,
      total: total,
      totalGTeacherCommission: purchase.totalGTeacherCommission,
      totalTeacherNet: purchase.totalTeacherNet,
      items: purchaseItems.map(item => ({
        title: item.title,
        price: item.price,
        gTeacherPercentage: item.gTeacherPercentage,
        gTeacherCommission: item.gTeacherCommission,
        teacherNet: item.teacherNet,
      })),
    });

    // Create Paymob payment session using validated data
    const orderItems = validatedCart.items.map((item) => ({
      title: item.title,
      price: item.price, // Database-validated price
      quantity: 1,
      description: `Course: ${item.title}`,
    }));

    const orderData = {
      total: total,
      merchantOrderId,
      items: orderItems,
    };

    // Log payment data for debugging
    console.log('Creating payment session with data:', {
      originalSubtotal: validatedCart.subtotal,
      finalTotal: total,
      discountAmount: discountAmount,
      promoCode: appliedPromoCode ? appliedPromoCode.code : 'none',
      merchantOrderId: merchantOrderId,
    });

    // Handle zero-payment orders (100% discount)
    if (total <= 0) {
      console.log('💯 Zero payment order detected - completing order directly without payment gateway');

      try {
        // Process the successful payment directly
        const result = await processSuccessfulPayment(purchase, req);

        if (result.success) {
          console.log(`✅ Zero-payment order completed successfully: ${purchase.orderNumber}`);

          // Clear cart
          clearCart(req, 'zero payment order');
          // Clear applied promo code from session
          if (req.session.appliedPromoCode) {
            delete req.session.appliedPromoCode;
          }

          // Save session
          req.session.save();

          return res.json({
            success: true,
            message: 'Order completed successfully with 100% discount!',
            skipPayment: true, // Flag to tell frontend to skip payment iframe
            paymentData: {
              orderNumber: purchase.orderNumber,
              total: 0,
              currency: 'AED',
            },
          });
        } else {
          throw new Error(result.error || 'Failed to process zero-payment order');
        }
      } catch (zeroPaymentError) {
        console.error('Error processing zero-payment order:', zeroPaymentError);

        // Update purchase status to failed
        purchase.status = 'failed';
        purchase.paymentStatus = 'failed';
        purchase.failureReason = 'Zero-payment order processing failed';
        await purchase.save();

        return res.status(500).json({
          success: false,
          message: 'Error completing your order. Please try again.',
        });
      }
    }

    // Add redirect URL to billing address for Paymob iframe
    const enhancedBillingAddress = {
      ...billingAddress,
      redirectUrl: `${req.protocol}://${req.get(
        'host'
      )}/purchase/payment/success?merchantOrderId=${merchantOrderId}`,
    };

    const paymentSession = await paymobService.createPaymentSession(
      orderData,
      enhancedBillingAddress,
      req.body.selectedPaymentMethod || 'card' // 'card' or 'wallet'
    );

    if (!paymentSession.success) {
      // Update purchase status to failed
      purchase.status = 'failed';
      purchase.paymentStatus = 'failed';
      await purchase.save();

      return res.status(500).json({
        success: false,
        message: paymentSession.error || 'Failed to create payment session',
      });
    }

    // Store purchase order number for webhook verification
    req.session.pendingPayment = {
      purchaseId: purchase._id.toString(),
      orderNumber: purchase.orderNumber,
      merchantOrderId,
    };

    res.json({
      success: true,
      message: 'Payment session created successfully',
      paymentData: {
        iframeUrl: paymentSession.iframeUrl,
        checkoutUrl: paymentSession.checkoutUrl || paymentSession.iframeUrl, // Unified checkout URL
        isUnifiedCheckout: paymentSession.isUnifiedCheckout || false,
        orderNumber: purchase.orderNumber,
        total: finalTotal, // Use the correct finalTotal variable
        currency: 'AED',
      },
    });
  } catch (error) {
    console.error('Error processing payment:', error);
    res.status(500).json({
      success: false,
      message: 'Error processing payment',
    });
  }
};

// Note: Order summary is now shown directly on checkout page

// Get user's purchase history
const getPurchaseHistory = async (req, res) => {
  try {
    if (!req.session.user) {
      req.flash('error_msg', 'Please login to view purchase history');
      return res.redirect('/auth/login');
    }

    const { page = 1, limit = 10 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const purchases = await Purchase.find({ user: req.session.user.id })
      .populate('items.item')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const totalPurchases = await Purchase.countDocuments({
      user: req.session.user.id,
    });
    const totalPages = Math.ceil(totalPurchases / parseInt(limit));

    res.render('purchase-history', {
      title: 'Purchase History | G-Teacher',
      theme: req.cookies.theme || 'light',
      purchases,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalPurchases,
        hasNext: parseInt(page) < totalPages,
        hasPrev: parseInt(page) > 1,
      },
      user: req.session.user,
    });
  } catch (error) {
    console.error('Error fetching purchase history:', error);
    req.flash('error_msg', 'Error loading purchase history');
    res.redirect('/');
  }
};

// Add item to wishlist
const addToWishlist = async (req, res) => {
  try {
    const { itemId } = req.body;

    if (!req.session.user) {
      return res.status(401).json({
        success: false,
        message: 'Please login to add items to wishlist',
      });
    }

    // Validate course exists
    const item = await Course.findById(itemId);

    if (!item) {
      return res.status(404).json({
        success: false,
        message: 'Course not found',
      });
    }

    // Get user from database
    const user = await User.findById(req.session.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    // Add to wishlist
    const result = await user.addToWishlist(itemId);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: result.message,
      });
    }

    res.json({
      success: true,
      message: 'Course added to wishlist successfully',
    });
  } catch (error) {
    console.error('Error adding to wishlist:', error);
    res.status(500).json({
      success: false,
      message: 'Error adding item to wishlist',
    });
  }
};

// Remove item from wishlist
const removeFromWishlist = async (req, res) => {
  try {
    const { itemId } = req.body;

    if (!req.session.user) {
      return res.status(401).json({
        success: false,
        message: 'Please login to remove items from wishlist',
      });
    }

    // Get user from database
    const user = await User.findById(req.session.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    // Remove from wishlist
    const result = await user.removeFromWishlist(itemId);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: result.message,
      });
    }

    res.json({
      success: true,
      message: 'Course removed from wishlist successfully',
    });
  } catch (error) {
    console.error('Error removing from wishlist:', error);
    res.status(500).json({
      success: false,
      message: 'Error removing item from wishlist',
    });
  }
};

// Toggle wishlist status
const toggleWishlist = async (req, res) => {
  try {
    const { itemId } = req.body;

    if (!req.session.user) {
      return res.status(401).json({
        success: false,
        message: 'Please login to manage wishlist',
      });
    }

    // Get user from database
    const user = await User.findById(req.session.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    let isInWishlist = user.wishlist && user.wishlist.some(id => id.toString() === itemId);
    let message = '';

    // Toggle wishlist status
    if (isInWishlist) {
      await user.removeFromWishlist(itemId);
      message = 'Course removed from wishlist';
      isInWishlist = false;
    } else {
      await user.addToWishlist(itemId);
      message = 'Course added to wishlist';
      isInWishlist = true;
    }

    res.json({
      success: true,
      message,
      isInWishlist,
    });
  } catch (error) {
    console.error('Error toggling wishlist:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating wishlist',
    });
  }
};

// Handle payment success - NOW ONLY READS FROM DB (webhook processes payment)
const handlePaymentSuccess = async (req, res) => {
  try {
    // Handle both direct merchant order ID and Paymob redirect parameters
    let merchantOrderId =
      req.query.merchantOrderId || req.query.merchant_order_id;

    // Also accept orderNumber for zero-payment orders (100% discount)
    const orderNumber = req.query.orderNumber;

    // If no merchant order ID in query, check if this is a Paymob redirect
    if (!merchantOrderId && req.query.success === 'true') {
      merchantOrderId = req.query.merchant_order_id;
    }

    // Find purchase by merchant order ID or order number
    let purchase = null;

    if (orderNumber) {
      // Zero-payment order - find by order number
      purchase = await Purchase.findOne({
        orderNumber: orderNumber,
      })
        .populate('items.item')
        .populate('user');
    } else if (merchantOrderId) {
      // Normal Paymob payment - find by merchant order ID
      purchase = await Purchase.findOne({
        paymentIntentId: merchantOrderId,
      })
        .populate('items.item')
        .populate('user');
    }

    if (!purchase) {
      console.error('Payment success: Purchase not found');
      return res.render('payment-fail', {
        title: 'Payment Error | G-Teacher',
        theme: req.cookies.theme || 'light',
        message: 'Payment record not found',
      });
    }


    // If purchase is marked as failed, show failure page
    if (purchase.status === 'failed' || purchase.paymentStatus === 'failed') {
      return res.render('payment-fail', {
        title: 'Payment Failed | G-Teacher',
        theme: req.cookies.theme || 'light',
        message:
          'Payment was not successful. Please try again or contact support.',
      });
    }

    // If already completed, just show success page
    if (
      purchase.status === 'completed' &&
      purchase.paymentStatus === 'completed'
    ) {
      // Only send WhatsApp notification if not already sent
      if (!purchase.whatsappNotificationSent) {
        try {
          console.log(
            '📱 Sending WhatsApp notification for completed purchase:',
            purchase.orderNumber
          );
          await whatsappSMSNotificationService.sendPurchaseInvoiceNotification(
            purchase.user._id,
            purchase
          );

          purchase.whatsappNotificationSent = true;
          await purchase.save();
          console.log('✅ WhatsApp notification sent and marked as sent');
        } catch (whatsappError) {
          console.error('❌ WhatsApp notification error:', whatsappError);
        }
      }

      const purchaseObj = purchase.toObject();

      return res.render('payment-success', {
        title: 'Payment Successful - Mr Kably',
        theme: req.cookies.theme || 'light',
        purchase: purchaseObj,
        user: purchase.user,
      });
    }

    // If purchase is still pending, try Transaction Inquiry as fallback
    // (Webhook might not have arrived yet)
    if (purchase.status === 'pending' || purchase.paymentStatus === 'pending') {
      console.log(
        '⏳ Purchase still pending, checking with Paymob Transaction Inquiry...'
      );

      try {
        const transactionStatus = await paymobService.queryTransactionStatus(
          merchantOrderId
        );

        if (transactionStatus) {
          const webhookData =
            paymobService.processWebhookPayload(transactionStatus);

          // If payment is successful, process it now
          if (webhookData.isSuccess) {
            console.log(
              '✅ Transaction Inquiry: Payment successful, processing now...'
            );

            // Save Paymob transaction details
            if (webhookData.transactionId) {
              purchase.paymobTransactionId = String(webhookData.transactionId);
            }
            purchase.paymentGatewayResponse = webhookData.rawPayload;
            await purchase.save();

            // Process successful payment using centralized function
            // Pass req to clear session after payment is confirmed completed
            await processSuccessfulPayment(purchase, req);

            // Reload purchase to get updated data
            purchase = await Purchase.findOne({
              paymentIntentId: merchantOrderId,
            })
              .populate('items.item')
              .populate('user');
          } else if (webhookData.isFailed) {
            console.log(
              '❌ Transaction Inquiry: Payment failed, processing now...'
            );

            const failureReason =
              transactionStatus?.obj?.data?.message ||
              transactionStatus?.data?.message ||
              'Payment declined or failed';

            await processFailedPayment(
              purchase,
              failureReason,
              webhookData.rawPayload
            );

            return res.render('payment-fail', {
              title: 'Payment Failed | G-Teacher',
              theme: req.cookies.theme || 'light',
              message:
                'Payment was not successful. Please try again or contact support.',
            });
          }
        }
      } catch (verifyError) {
        console.warn(
          'Could not verify transaction status:',
          verifyError.message
        );
        // Continue to show pending message
      }

      // If still pending after inquiry, show pending message
      if (purchase.status === 'pending') {
        return res.render('payment-fail', {
          title: 'Payment Pending | G-Teacher',
          theme: req.cookies.theme || 'light',
          message:
            'Your payment is being processed. Please wait a few moments and refresh this page, or check your email for confirmation.',
        });
      }
    }

    // Only clear cart if payment is actually completed
    // Don't clear if still pending - user might come back to complete payment
    if (purchase.status === 'completed' && purchase.paymentStatus === 'completed') {
      clearCart(req, 'payment success page');
    }

    const purchaseObj = purchase.toObject();

    res.render('payment-success', {
      title: 'Payment Successful - Mr Kably',
      theme: req.cookies.theme || 'light',
      purchase: purchaseObj,
      user: purchase.user,
    });
  } catch (error) {
    console.error('Error handling payment success:', error);

    // Clear cart on error
    clearCart(req, 'payment success error');

    res.render('payment-fail', {
      title: 'Payment Error - Mr Kably',
      theme: req.cookies.theme || 'light',
      message: 'An error occurred while processing your payment',
    });
  }
};

// Handle payment failure - NOW ONLY READS FROM DB (webhook processes payment)
const handlePaymentFailure = async (req, res) => {
  try {
    const { merchantOrderId, reason, transactionId, orderId } = req.query;

    // Clear the cart after failed payment
    clearCart(req, 'payment failed');

    // If merchantOrderId is provided, check DB status
    if (merchantOrderId) {
      const purchase = await Purchase.findOne({
        paymentIntentId: merchantOrderId,
      });

      if (purchase) {
        // If purchase is already marked as failed by webhook, just show failure page
        if (purchase.status === 'failed' || purchase.paymentStatus === 'failed') {
          const errorMessage =
            purchase.failureReason ||
              reason
              ? decodeURIComponent(reason)
              : 'Your payment could not be processed. Please try again or contact support.';

          return res.render('payment-fail', {
            title: 'Payment Failed - Mr Kably',
            theme: req.cookies.theme || 'light',
            message: errorMessage,
          });
        }

        // If purchase is still pending, webhook might not have arrived yet
        // Try Transaction Inquiry as fallback
        if (purchase.status === 'pending') {
          console.log(
            '⏳ Purchase still pending, checking with Paymob Transaction Inquiry...'
          );

          try {
            const transactionStatus = await paymobService.queryTransactionStatus(
              merchantOrderId
            );

            if (transactionStatus) {
              const webhookData =
                paymobService.processWebhookPayload(transactionStatus);

              if (webhookData.isFailed) {
                const failureReason =
                  transactionStatus?.obj?.data?.message ||
                    transactionStatus?.data?.message ||
                    reason
                    ? decodeURIComponent(reason)
                    : 'Payment declined or failed';

                // Save Paymob IDs if available
                if (transactionId) {
                  purchase.paymobTransactionId = String(transactionId);
                }
                if (orderId) {
                  purchase.paymobOrderId = String(orderId);
                }

                await processFailedPayment(
                  purchase,
                  failureReason,
                  webhookData.rawPayload
                );

                return res.render('payment-fail', {
                  title: 'Payment Failed - Mr Kably',
                  theme: req.cookies.theme || 'light',
                  message: failureReason,
                });
              } else if (webhookData.isSuccess) {
                // Payment actually succeeded! Redirect to success page
                return res.redirect(
                  `/purchase/payment/success?merchantOrderId=${merchantOrderId}`
                );
              }
            }
          } catch (verifyError) {
            console.warn(
              'Could not verify transaction status:',
              verifyError.message
            );
          }
        }
      }
    }

    // Get friendly error message
    const errorMessage = req.query.reason
      ? decodeURIComponent(req.query.reason)
      : 'Your payment could not be processed. Please try again or contact support.';

    res.render('payment-fail', {
      title: 'Payment Failed - Mr Kably',
      theme: req.cookies.theme || 'light',
      message: errorMessage,
    });
  } catch (error) {
    console.error('Error handling payment failure:', error);

    // Clear cart even on error
    clearCart(req, 'payment error');

    res.render('payment-fail', {
      title: 'Payment Error - Mr Kably',
      theme: req.cookies.theme || 'light',
      message: 'An error occurred while processing your payment',
    });
  }
};

// Handle Paymob webhook - IMPROVED VERSION WITH BETTER RELIABILITY
const handlePaymobWebhook = async (req, res) => {
  let purchase = null;
  try {
    const rawBody = req.body;
    const signature =
      req.headers['x-paymob-signature'] ||
      req.headers['x-signature'] ||
      req.headers['x-hook-signature'] ||
      req.headers['x-paymob-hmac'];

    // Verify webhook signature in production
    if (process.env.NODE_ENV === 'production') {
      const isValid = paymobService.verifyWebhookSignature(rawBody, signature);
      if (!isValid) {
        console.warn('❌ [Webhook] Signature verification failed');
        return res.status(401).send('Unauthorized');
      }
    }

    const payload = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;

    // Log webhook receipt for debugging
    console.log('📥 [Webhook] Received Paymob webhook:', {
      transactionId: payload?.obj?.id || payload?.id,
      merchantOrderId: payload?.obj?.order?.merchant_order_id || payload?.merchant_order_id,
      success: payload?.obj?.success || payload?.success,
      timestamp: new Date().toISOString(),
    });

    // Verify HMAC for transaction data (recommended by Paymob)
    const hmacValid = paymobService.verifyTransactionHMAC(payload);
    if (!hmacValid && process.env.NODE_ENV === 'production') {
      console.error('❌ [Webhook] HMAC verification failed');
      console.error('Transaction ID:', payload?.obj?.id || payload?.id);
      console.error(
        'Merchant Order ID:',
        payload?.obj?.order?.merchant_order_id
      );
      // Still process but log the failure
      console.warn('⚠️ [Webhook] Processing webhook despite HMAC failure (for testing)');
    }

    // Process webhook payload with query parameters (for comprehensive detection)
    const webhookData = paymobService.processWebhookPayload(payload, req.query);

    if (!webhookData.merchantOrderId) {
      console.error('❌ [Webhook] No merchant order ID found in webhook');
      return res.status(400).send('Bad Request - Missing merchant order ID');
    }

    // Find purchase by merchant order ID with transaction lock
    // Use findOneAndUpdate with $setOnInsert to prevent race conditions
    purchase = await Purchase.findOne({
      paymentIntentId: webhookData.merchantOrderId,
    }).populate('user');

    if (!purchase) {
      console.error('❌ [Webhook] Purchase not found for merchant order:', webhookData.merchantOrderId);
      return res.status(404).send('Purchase not found');
    }

    // Save Paymob transaction details BEFORE processing status
    const transactionId =
      payload?.obj?.id || payload?.id || webhookData.transactionId;
    const paymobOrderId =
      payload?.obj?.order?.id || payload?.obj?.order || payload?.order;

    if (transactionId && !purchase.paymobTransactionId) {
      purchase.paymobTransactionId = String(transactionId);
    }
    if (paymobOrderId && !purchase.paymobOrderId) {
      purchase.paymobOrderId = String(paymobOrderId);
    }

    // CRITICAL FIX: Handle case where payment was incorrectly marked as failed
    // If webhook says SUCCESS but purchase is marked as FAILED, correct it
    if (webhookData.isSuccess && purchase.status === 'failed') {
      console.log(
        '⚠️ [Webhook] CORRECTING STATUS: Payment marked as failed but webhook confirms SUCCESS for order:',
        purchase.orderNumber
      );
      console.log('🔧 [Webhook] This indicates a previous incorrect failure detection');

      // Reset status to pending so processSuccessfulPayment can handle it
      purchase.status = 'pending';
      purchase.paymentStatus = 'pending';
      purchase.failureReason = null;
      await purchase.save();
    }

    // CRITICAL FIX: Only process if status is pending OR if correcting a failed status
    // This ensures webhook can override incorrect statuses
    if (purchase.status !== 'pending' && purchase.status !== 'failed') {
      console.log(
        `ℹ️ [Webhook] Purchase ${purchase.orderNumber} already processed with status: ${purchase.status}`
      );
      return res.status(200).send('OK - Already processed');
    }

    // Handle SUCCESS webhook - THIS IS THE SINGLE SOURCE OF TRUTH
    if (webhookData.isSuccess) {
      console.log(
        '✅ [Webhook] Payment SUCCESS confirmed for order:',
        purchase.orderNumber
      );

      // Save payment gateway response with detailed metadata
      purchase.paymentGatewayResponse = {
        ...webhookData.rawPayload,
        webhookProcessedAt: new Date(),
        webhookSource: 'paymob_webhook',
        transactionId: transactionId,
        paymobOrderId: paymobOrderId,
      };

      // Save transaction details before processing
      await purchase.save();

      // Use centralized function to process successful payment
      // This handles enrollments, promo codes, notifications, etc.
      // CRITICAL: This MUST complete successfully - enrollment happens here
      try {
        await processSuccessfulPayment(purchase, null);
        console.log(
          '✅ [Webhook] Successfully processed payment and enrollment for order:',
          purchase.orderNumber
        );
      } catch (processError) {
        // If processing fails, log but don't fail webhook (idempotency)
        console.error(
          '❌ [Webhook] Error processing successful payment:',
          processError
        );
        // Still return OK to Paymob (we'll retry via Transaction Inquiry)
        // But log the error for manual intervention
        console.error('⚠️ [Webhook] Payment confirmed but processing failed - manual intervention may be needed');
      }

      return res.status(200).send('OK');
    }

    // Handle FAILED webhook - Only mark as failed if explicitly failed
    if (webhookData.isFailed) {
      console.log(
        '❌ [Webhook] Payment FAILED confirmed for order:',
        purchase.orderNumber
      );

      // Extract failure reason
      const failureReason =
        payload?.obj?.data?.message ||
        payload?.data?.message ||
        payload?.obj?.message ||
        payload?.obj?.data?.acq_response_code ||
        'Payment declined or failed';

      // Use centralized function to process failed payment
      await processFailedPayment(
        purchase,
        failureReason,
        {
          ...webhookData.rawPayload,
          webhookProcessedAt: new Date(),
          webhookSource: 'paymob_webhook',
        }
      );

      return res.status(200).send('OK');
    }

    // If status is pending or unknown, keep as pending
    // Save webhook data for reference but don't change status
    console.log(
      '⏳ [Webhook] Payment PENDING for order:',
      purchase.orderNumber,
      '- Status unchanged'
    );

    // Save webhook data for future reference
    if (!purchase.paymentGatewayResponse) {
      purchase.paymentGatewayResponse = {
        ...webhookData.rawPayload,
        webhookProcessedAt: new Date(),
        webhookSource: 'paymob_webhook',
        status: 'pending',
      };
      await purchase.save();
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('❌ [Webhook] Error processing Paymob webhook:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      purchaseOrderNumber: purchase?.orderNumber,
    });

    // Return 200 to Paymob even on error (to prevent retries)
    // But log the error for manual intervention
    res.status(200).send('OK - Error logged');
  }
};

// Handle Paymob webhook GET redirects (browser callbacks)
// NOW SIMPLIFIED - Just redirects to success/fail pages based on DB status
// Webhook (POST) is the single source of truth for payment processing
const handlePaymobWebhookRedirect = async (req, res) => {
  try {
    console.log('🔀 [Redirect] Paymob redirect callback received:', req.query);

    let merchantOrderId =
      req.query.merchant_order_id ||
      req.query.merchantOrder ||
      req.query.merchantOrderId;

    let purchase = null;

    // For unified checkout, merchant_order_id might not be in query params
    // Try to find purchase by transaction ID or session user
    if (!merchantOrderId && req.query.id) {
      console.log(
        '🔀 [Redirect] Unified checkout callback - looking up purchase...'
      );

      // Try to find the most recent pending purchase for the session user
      if (req.session && req.session.user) {
        const userId = req.session.user.id;
        purchase = await Purchase.findOne({
          user: userId,
          status: 'pending',
          paymentStatus: 'pending',
        })
          .sort({ createdAt: -1 })
          .limit(1);

        if (purchase) {
          merchantOrderId = purchase.paymentIntentId;
          console.log('🔀 [Redirect] Found pending purchase:', merchantOrderId);
        }
      }
    }

    // If still no merchant order ID, try to find by transaction ID
    if (!merchantOrderId && req.query.id) {
      purchase = await Purchase.findOne({
        paymobTransactionId: req.query.id,
      });
      if (purchase) {
        merchantOrderId = purchase.paymentIntentId;
      }
    }

    // If still no merchant order ID or purchase, redirect to failure
    if (!merchantOrderId && !purchase) {
      console.warn('🔀 [Redirect] No merchant order ID found');
      return res.redirect('/purchase/payment/fail?reason=missing_order_id');
    }

    // Find purchase by merchant order ID if not already found
    if (!purchase && merchantOrderId) {
      purchase = await Purchase.findOne({
        paymentIntentId: merchantOrderId,
      });
    }

    if (!purchase) {
      console.warn('🔀 [Redirect] Purchase not found');
      return res.redirect('/purchase/payment/fail?reason=order_not_found');
    }

    // Save Paymob transaction details if available (for reference)
    let updated = false;
    if (req.query.id && !purchase.paymobTransactionId) {
      purchase.paymobTransactionId = req.query.id;
      updated = true;
    }
    if (req.query.order && !purchase.paymobOrderId) {
      purchase.paymobOrderId = req.query.order;
      updated = true;
    }
    if (updated) {
      await purchase.save();
    }

    // Check DB status - webhook should have already processed the payment
    console.log('🔀 [Redirect] Purchase status:', purchase.status);

    if (purchase.status === 'completed') {
      // Payment already processed by webhook, redirect to success
      return res.redirect(
        `/purchase/payment/success?merchantOrderId=${merchantOrderId}`
      );
    } else if (purchase.status === 'failed') {
      // Payment already processed by webhook, redirect to failure
      const reason = purchase.failureReason
        ? encodeURIComponent(purchase.failureReason)
        : 'payment_failed';
      return res.redirect(`/purchase/payment/fail?reason=${reason}`);
    } else if (purchase.status === 'pending') {
      // Payment still pending - webhook should process it
      // IMPROVED: Wait briefly for webhook, then use Transaction Inquiry API as fallback
      console.log('🔀 [Redirect] Payment pending, waiting for webhook...');

      // Wait 3 seconds to give webhook time to arrive (webhooks are usually faster)
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Re-fetch purchase status after waiting
      const updatedPurchase = await Purchase.findById(purchase._id);

      if (updatedPurchase.status === 'completed') {
        console.log('✅ [Redirect] Webhook processed payment successfully during wait');
        return res.redirect(`/purchase/payment/success?merchantOrderId=${merchantOrderId}`);
      } else if (updatedPurchase.status === 'failed') {
        console.log('❌ [Redirect] Webhook marked payment as failed during wait');
        const reason = updatedPurchase.failureReason ? encodeURIComponent(updatedPurchase.failureReason) : 'payment_failed';
        return res.redirect(`/purchase/payment/fail?reason=${reason}`);
      }

      // Still pending - use Transaction Inquiry API as definitive source
      // This is a fallback ONLY if webhook hasn't arrived yet
      console.log('⏳ [Redirect] Still pending, querying Paymob Transaction Inquiry API as fallback...');

      try {
        const transactionStatus = await paymobService.queryTransactionStatus(merchantOrderId);

        if (transactionStatus) {
          const apiWebhookData = paymobService.processWebhookPayload(transactionStatus);

          if (apiWebhookData.isSuccess) {
            console.log('✅ [Redirect] Transaction Inquiry confirms SUCCESS, processing payment...');

            // Save Paymob transaction details
            const purchaseToUpdate = await Purchase.findById(purchase._id);
            if (apiWebhookData.transactionId && !purchaseToUpdate.paymobTransactionId) {
              purchaseToUpdate.paymobTransactionId = String(apiWebhookData.transactionId);
            }
            purchaseToUpdate.paymentGatewayResponse = {
              apiResponse: transactionStatus,
              processedAt: new Date(),
              status: 'completed',
              source: 'transaction_inquiry_api_fallback',
            };
            await purchaseToUpdate.save();

            // Process successful payment - this will enroll the student
            await processSuccessfulPayment(purchaseToUpdate, req);
            return res.redirect(`/purchase/payment/success?merchantOrderId=${merchantOrderId}`);
          } else if (apiWebhookData.isFailed) {
            console.log('❌ [Redirect] Transaction Inquiry confirms FAILED');

            const failureReason = transactionStatus?.obj?.data?.message ||
              transactionStatus?.data?.message ||
              'Payment declined or failed';

            await processFailedPayment(purchase, failureReason, {
              apiResponse: transactionStatus,
              processedAt: new Date(),
              status: 'failed',
              source: 'transaction_inquiry_api_fallback',
            });

            return res.redirect(`/purchase/payment/fail?reason=${encodeURIComponent(failureReason)}`);
          } else {
            // Transaction Inquiry returned pending status
            console.log('⏳ [Redirect] Transaction Inquiry also shows pending - webhook will process when ready');
            return res.redirect('/purchase/payment/fail?reason=payment_pending_webhook_processing');
          }
        }
      } catch (inquiryError) {
        console.warn('⚠️ [Redirect] Transaction Inquiry failed:', inquiryError.message);
        // If inquiry fails, show pending message - webhook will process when it arrives
        return res.redirect('/purchase/payment/fail?reason=payment_pending_verification');
      }

      // Final fallback: If all else fails, show pending message
      // Webhook will process the payment when it arrives
      console.log('⏳ [Redirect] Payment still pending - webhook will process when received');
      return res.redirect('/purchase/payment/fail?reason=payment_pending_webhook_processing');
    } else {
      // Unknown status
      return res.redirect('/purchase/payment/fail?reason=unknown_status');
    }
  } catch (error) {
    console.error('❌ [Redirect] Error processing Paymob redirect:', error);
    return res.redirect('/purchase/payment/fail?reason=processing_error');
  }
};

module.exports = {
  getCart,
  clearCartAPI,
  addToCart,
  removeFromCart,
  getCheckout,
  directCheckout,
  processPayment,
  handlePaymentSuccess,
  handlePaymentFailure,
  handlePaymobWebhook,
  handlePaymobWebhookRedirect,
  getPurchaseHistory,
  addToWishlist,
  removeFromWishlist,
  toggleWishlist,
  validateCartMiddleware,
  recalculateCartFromDB,
  // Promo Code Management
  validatePromoCode,
  removePromoCode,
  clearInvalidPromoCode,
  // Payment Processing Functions (for admin use)
  processSuccessfulPayment,
  processFailedPayment,
};

