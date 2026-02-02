const mongoose = require('mongoose');

const invoiceSchema = new mongoose.Schema({
  // Invoice identification
  invoiceNumber: {
    type: String,
    required: true,
    unique: true
  },
  
  // Teacher reference
  teacherId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Teacher',
    required: true
  },
  teacherName: {
    type: String,
    required: true
  },
  teacherCode: {
    type: String
  },
  teacherPhone: {
    type: String
  },
  teacherEmail: {
    type: String
  },
  
  // Date range for the invoice
  dateRange: {
    start: {
      type: Date,
      required: true
    },
    end: {
      type: Date,
      required: true
    },
    displayStart: String,
    displayEnd: String
  },
  
  // Courses summary
  courses: [{
    courseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course'
    },
    title: String,
    ordersCount: Number,
    refundsCount: Number,
    netTotal: Number
  }],
  
  // Financial summary
  totalOrders: {
    type: Number,
    default: 0
  },
  totalRefunds: {
    type: Number,
    default: 0
  },
  totalPayout: {
    type: Number,
    required: true
  },
  
  // PDF storage
  pdfPath: {
    type: String
  },
  pdfUrl: {
    type: String
  },
  
  // Invoice status
  status: {
    type: String,
    enum: ['draft', 'generated', 'sent'],
    default: 'generated'
  },
  
  // Payment details
  paymentMethod: {
    type: String,
    enum: ['bank_transfer', 'cash', 'cheque', 'other', 'pending'],
    default: 'pending'
  },
  paymentDetails: {
    bankName: String,
    accountNumber: String,
    transactionId: String,
    notes: String
  },
  
  // Timestamps
  generatedAt: {
    type: Date,
    default: Date.now
  },
  sentAt: {
    type: Date
  },
  paidAt: {
    type: Date
  },
  
  // Who generated/managed
  generatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin'
  },
  markedPaidBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin'
  },
  
  // Notes
  notes: {
    type: String
  }
}, {
  timestamps: true
});

// Index for faster queries
invoiceSchema.index({ teacherId: 1, createdAt: -1 });
invoiceSchema.index({ status: 1 });
invoiceSchema.index({ invoiceNumber: 1 });

// Static method to generate invoice number
invoiceSchema.statics.generateInvoiceNumber = async function() {
  const date = new Date();
  const year = date.getFullYear().toString().slice(-2);
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  
  // Find the last invoice of this month
  const lastInvoice = await this.findOne({
    invoiceNumber: new RegExp(`^INV-${year}${month}`)
  }).sort({ invoiceNumber: -1 });
  
  let sequence = 1;
  if (lastInvoice) {
    const lastSequence = parseInt(lastInvoice.invoiceNumber.slice(-4));
    sequence = lastSequence + 1;
  }
  
  return `INV-${year}${month}-${sequence.toString().padStart(4, '0')}`;
};

module.exports = mongoose.model('Invoice', invoiceSchema);
