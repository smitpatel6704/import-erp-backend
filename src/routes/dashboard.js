import { db } from '../db.js';
import { Router } from 'express';
const router = Router();
router.get('/', async (req, res) => {
    try {
        const [{ totalShipments }] = await db.query('SELECT COUNT(*) as totalShipments FROM Shipment WHERE isActive = 1');
        const shipmentsByStatus = await db.query('SELECT status, COUNT(*) as count FROM Shipment WHERE isActive = 1 GROUP BY status');
        const shipmentsByPriority = await db.query('SELECT priority, COUNT(*) as count FROM Shipment WHERE isActive = 1 GROUP BY priority');
        const [{ activeShipments }] = await db.query("SELECT COUNT(*) as activeShipments FROM Shipment WHERE isActive = 1 AND status NOT IN ('draft', 'closed')");
        const [{ inTransitShipments }] = await db.query("SELECT COUNT(*) as inTransitShipments FROM Shipment WHERE isActive = 1 AND status IN ('in_transit', 'vessel_departed')");
        const [{ customsClearanceShipments }] = await db.query("SELECT COUNT(*) as customsClearanceShipments FROM Shipment WHERE isActive = 1 AND status = 'customs_clearance'");
        const deliveredThisMonth = await db.query("SELECT COUNT(*) as count FROM Shipment WHERE isActive = 1 AND status IN ('delivered', 'closed') AND actualArrival >= ?", [new Date(new Date().getFullYear(), new Date().getMonth(), 1)]);
        const [{ totalShipmentValue }] = await db.query('SELECT SUM(shipmentValue) as sum FROM Shipment WHERE isActive = 1');
        const [totalExpenses] = await db.query('SELECT SUM(amount) as amount, SUM(amountBase) as amountBase FROM Expense WHERE isActive = 1');
        const expensesByCategory = await db.query('SELECT category, SUM(amount) as amount FROM Expense WHERE isActive = 1 GROUP BY category');
        const expensesByPaymentStatus = await db.query('SELECT paymentStatus, SUM(amount) as amount, COUNT(*) as count FROM Expense WHERE isActive = 1 GROUP BY paymentStatus');
        const [pendingPayments] = await db.query("SELECT SUM(amount) as amount FROM Expense WHERE isActive = 1 AND paymentStatus IN ('pending', 'partial', 'overdue')");
        const [overduePayments] = await db.query("SELECT SUM(amount) as amount, COUNT(id) as count FROM Expense WHERE isActive = 1 AND paymentStatus = 'overdue'");
        const [{ totalInvoices }] = await db.query('SELECT COUNT(*) as totalInvoices FROM Invoice WHERE isActive = 1');
        const invoicesByStatus = await db.query('SELECT status, COUNT(*) as count, SUM(totalAmount) as totalAmount, SUM(paidAmount) as paidAmount FROM Invoice WHERE isActive = 1 GROUP BY status');
        const [totalInvoiceAmount] = await db.query('SELECT SUM(totalAmount) as totalAmount, SUM(paidAmount) as paidAmount FROM Invoice WHERE isActive = 1');
        const [{ totalContainers }] = await db.query('SELECT COUNT(*) as totalContainers FROM Container WHERE isActive = 1');
        const containersByStatus = await db.query('SELECT status, COUNT(*) as count FROM Container WHERE isActive = 1 GROUP BY status');
        const containersByType = await db.query('SELECT containerType, COUNT(*) as count FROM Container WHERE isActive = 1 GROUP BY containerType');
        const containersBySize = await db.query('SELECT containerSize, COUNT(*) as count FROM Container WHERE isActive = 1 GROUP BY containerSize');
        const [{ totalCompanies }] = await db.query('SELECT COUNT(*) as totalCompanies FROM Company WHERE isActive = 1');
        const [{ totalProducts }] = await db.query('SELECT COUNT(*) as totalProducts FROM Product WHERE isActive = 1');
        const topCompaniesByValue = await db.query(`
      SELECT s.companyId, c.name as companyName, SUM(s.shipmentValue) as totalValue, COUNT(s.id) as shipmentCount 
      FROM Shipment s LEFT JOIN Company c ON s.companyId = c.id 
      WHERE s.isActive = 1 AND s.companyId IS NOT NULL 
      GROUP BY s.companyId, c.name 
      ORDER BY totalValue DESC LIMIT 5
    `);
        const [{ totalDocuments }] = await db.query('SELECT COUNT(*) as totalDocuments FROM Document WHERE isActive = 1');
        const documentsByType = await db.query('SELECT documentType, COUNT(*) as count FROM Document WHERE isActive = 1 GROUP BY documentType');
        const [{ verifiedDocuments }] = await db.query('SELECT COUNT(*) as verifiedDocuments FROM Document WHERE isActive = 1 AND isVerified = 1');
        const [{ totalCustomsRecords }] = await db.query('SELECT COUNT(*) as totalCustomsRecords FROM CustomsClearance WHERE isActive = 1');
        const customsByStatus = await db.query('SELECT clearanceStatus, COUNT(*) as count FROM CustomsClearance WHERE isActive = 1 GROUP BY clearanceStatus');
        const [totalDutyAmount] = await db.query('SELECT SUM(dutyAmount) as dutyAmount, SUM(assessmentValue) as assessmentValue FROM CustomsClearance WHERE isActive = 1');
        const [{ totalLogistics }] = await db.query('SELECT COUNT(*) as totalLogistics FROM Logistics WHERE isActive = 1');
        const logisticsByStatus = await db.query('SELECT status, COUNT(*) as count FROM Logistics WHERE isActive = 1 GROUP BY status');
        const [{ unreadNotifications }] = await db.query('SELECT COUNT(*) as unreadNotifications FROM Notification WHERE isRead = 0');
        const [{ totalNotifications }] = await db.query('SELECT COUNT(*) as totalNotifications FROM Notification');
        const recentShipments = await db.query(`
      SELECT s.id, s.shipmentNumber, s.bookingNumber, s.shippingLine, s.vesselName, 
             s.originCountry, s.originPort, s.destinationPort, s.status, s.priority, 
             s.etd, s.eta, s.shipmentValue, s.currency, s.createdAt,
             c.name as companyName
      FROM Shipment s LEFT JOIN Company c ON s.companyId = c.id
      WHERE s.isActive = 1 ORDER BY s.createdAt DESC LIMIT 6
    `);
        // Format nested company
        const formattedRecentShipments = recentShipments.map((s) => ({
            ...s,
            company: s.companyName ? { name: s.companyName } : null,
            companyName: undefined
        }));
        const recentActivities = await db.query(`
      SELECT a.*, u.name as userName, u.avatar as userAvatar 
      FROM Activity a LEFT JOIN User u ON a.userId = u.id 
      ORDER BY a.createdAt DESC LIMIT 10
    `);
        const formattedActivities = recentActivities.map((a) => ({
            ...a,
            user: a.userName ? { name: a.userName, avatar: a.userAvatar } : null,
            userName: undefined,
            userAvatar: undefined
        }));
        const monthlyTrend = [];
        for (let i = 5; i >= 0; i--) {
            const date = new Date();
            date.setMonth(date.getMonth() - i);
            const monthStart = new Date(date.getFullYear(), date.getMonth(), 1);
            const monthEnd = new Date(date.getFullYear(), date.getMonth() + 1, 0);
            const [{ count }] = await db.query('SELECT COUNT(*) as count FROM Shipment WHERE createdAt >= ? AND createdAt <= ?', [monthStart, monthEnd]);
            const [{ value }] = await db.query('SELECT SUM(shipmentValue) as value FROM Shipment WHERE createdAt >= ? AND createdAt <= ? AND shipmentValue > 0', [monthStart, monthEnd]);
            monthlyTrend.push({
                month: monthStart.toLocaleString('default', { month: 'short', year: '2-digit' }),
                shipments: count || 0,
                value: value || 0,
            });
        }
        const shipmentsByShippingLine = await db.query('SELECT shippingLine, COUNT(*) as count FROM Shipment WHERE isActive = 1 AND shippingLine IS NOT NULL GROUP BY shippingLine ORDER BY count DESC');
        const shipmentsByOrigin = await db.query('SELECT originCountry as country, COUNT(*) as count, SUM(shipmentValue) as value FROM Shipment WHERE isActive = 1 AND originCountry IS NOT NULL GROUP BY originCountry ORDER BY count DESC');
        return res.json({
            shipments: {
                total: totalShipments || 0,
                active: activeShipments || 0,
                inTransit: inTransitShipments || 0,
                customsClearance: customsClearanceShipments || 0,
                deliveredThisMonth: deliveredThisMonth[0]?.count || 0,
                byStatus: shipmentsByStatus || [],
                byPriority: shipmentsByPriority || [],
                totalValue: totalShipmentValue?.sum || 0,
                monthlyTrend,
                byShippingLine: shipmentsByShippingLine || [],
                byOriginCountry: shipmentsByOrigin || [],
            },
            financials: {
                totalExpenses: totalExpenses?.amount || 0,
                totalExpensesBase: totalExpenses?.amountBase || 0,
                expensesByCategory: expensesByCategory || [],
                expensesByPaymentStatus: expensesByPaymentStatus || [],
                pendingPayments: pendingPayments?.amount || 0,
                overduePayments: overduePayments?.amount || 0,
                overdueCount: overduePayments?.count || 0,
                totalInvoiceAmount: totalInvoiceAmount?.totalAmount || 0,
                totalPaidAmount: totalInvoiceAmount?.paidAmount || 0,
                invoicesByStatus: invoicesByStatus || [],
                totalDutyAmount: totalDutyAmount?.dutyAmount || 0,
                totalAssessmentValue: totalDutyAmount?.assessmentValue || 0,
            },
            containers: {
                total: totalContainers || 0,
                byStatus: containersByStatus || [],
                byType: containersByType || [],
                bySize: containersBySize || [],
            },
            companies: {
                total: totalCompanies || 0,
                topByValue: topCompaniesByValue || [],
            },
            products: {
                total: totalProducts || 0,
            },
            invoices: {
                total: totalInvoices || 0,
            },
            documents: {
                total: totalDocuments || 0,
                verified: verifiedDocuments || 0,
                byType: documentsByType || [],
            },
            customs: {
                total: totalCustomsRecords || 0,
                byStatus: customsByStatus || [],
            },
            logistics: {
                total: totalLogistics || 0,
                byStatus: logisticsByStatus || [],
            },
            notifications: {
                total: totalNotifications || 0,
                unread: unreadNotifications || 0,
            },
            recentShipments: formattedRecentShipments,
            recentActivities: formattedActivities,
        });
    }
    catch (error) {
        console.error('Dashboard error:', error);
        return res.status(500).json({ error: String(error) });
    }
});
export default router;
