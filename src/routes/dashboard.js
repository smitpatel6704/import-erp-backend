import { db } from '../db.js';
import { Router } from 'express';
const router = Router();
router.get('/', async (req, res) => {
    try {
        const [
            [{ totalShipments }],
            shipmentsByStatus,
            shipmentsByPriority,
            [{ activeShipments }],
            [{ inTransitShipments }],
            [{ atPolShipments }],
            [{ atPodShipments }],
            [{ customsClearanceShipments }],
            [{ deliveredShipments }],
            deliveredThisMonth,
            [totalExpenses],
            expensesByCategory,
            expensesByPaymentStatus,
            [pendingPayments],
            [overduePayments],
            [{ totalInvoices }],
            invoicesByStatus,
            [totalInvoiceAmount],
            [{ totalContainers }],
            containersByStatus,
            containersByType,
            containersBySize,
            [{ totalCompanies }],
            [{ totalProducts }],
            topCompaniesByValue,
            [{ totalDocuments }],
            documentsByType,
            [{ verifiedDocuments }],
            [{ totalCustomsRecords }],
            customsByStatus,
            [totalDutyAmount],
            [{ totalLogistics }],
            logisticsByStatus,
            [{ unreadNotifications }],
            [{ totalNotifications }],
            recentShipments,
            recentActivities,
            shipmentsByShippingLine,
            shipmentsByOrigin,
            shipmentsByPort,
            shipmentsBySupplier,
            yearlyTrend,
        ] = await Promise.all([
            db.query('SELECT COUNT(*) as totalShipments FROM Shipment WHERE isActive = 1'),
            db.query('SELECT status, COUNT(*) as count FROM Shipment WHERE isActive = 1 GROUP BY status'),
            db.query('SELECT priority, COUNT(*) as count FROM Shipment WHERE isActive = 1 GROUP BY priority'),
            db.query("SELECT COUNT(*) as activeShipments FROM Shipment WHERE isActive = 1 AND status NOT IN ('draft', 'closed')"),
            db.query("SELECT COUNT(*) as inTransitShipments FROM Shipment WHERE isActive = 1 AND status IN ('in_transit', 'vessel_departed')"),
            db.query("SELECT COUNT(*) as atPolShipments FROM Shipment WHERE isActive = 1 AND status = 'at_pol'"),
            db.query("SELECT COUNT(*) as atPodShipments FROM Shipment WHERE isActive = 1 AND status = 'at_pod'"),
            db.query("SELECT COUNT(*) as customsClearanceShipments FROM Shipment WHERE isActive = 1 AND status = 'customs_clearance'"),
            db.query("SELECT COUNT(*) as deliveredShipments FROM Shipment WHERE isActive = 1 AND status IN ('delivered', 'closed')"),
            db.query("SELECT COUNT(*) as count FROM Shipment WHERE isActive = 1 AND status IN ('delivered', 'closed') AND actualArrival >= ?", [new Date(new Date().getFullYear(), new Date().getMonth(), 1)]),
            db.query('SELECT SUM(amount) as amount, SUM(amountBase) as amountBase FROM Expense WHERE isActive = 1'),
            db.query('SELECT category, SUM(amount) as amount FROM Expense WHERE isActive = 1 GROUP BY category'),
            db.query('SELECT paymentStatus, SUM(amount) as amount, COUNT(*) as count FROM Expense WHERE isActive = 1 GROUP BY paymentStatus'),
            db.query("SELECT SUM(amount) as amount FROM Expense WHERE isActive = 1 AND paymentStatus IN ('pending', 'partial', 'overdue')"),
            db.query("SELECT SUM(amount) as amount, COUNT(id) as count FROM Expense WHERE isActive = 1 AND paymentStatus = 'overdue'"),
            db.query('SELECT COUNT(*) as totalInvoices FROM Invoice WHERE isActive = 1'),
            db.query('SELECT status, COUNT(*) as count, SUM(totalAmount) as totalAmount, SUM(paidAmount) as paidAmount FROM Invoice WHERE isActive = 1 GROUP BY status'),
            db.query('SELECT SUM(totalAmount) as totalAmount, SUM(paidAmount) as paidAmount FROM Invoice WHERE isActive = 1'),
            db.query('SELECT COUNT(*) as totalContainers FROM Container WHERE isActive = 1'),
            db.query('SELECT status, COUNT(*) as count FROM Container WHERE isActive = 1 GROUP BY status'),
            db.query('SELECT containerType, COUNT(*) as count FROM Container WHERE isActive = 1 GROUP BY containerType'),
            db.query('SELECT containerSize, COUNT(*) as count FROM Container WHERE isActive = 1 GROUP BY containerSize'),
            db.query('SELECT COUNT(*) as totalCompanies FROM Company WHERE isActive = 1'),
            db.query('SELECT COUNT(*) as totalProducts FROM Product WHERE isActive = 1'),
            db.query(`
              SELECT s.companyId, c.name as "companyName", COUNT(s.id) as "shipmentCount" 
              FROM Shipment s LEFT JOIN Company c ON s.companyId = c.id 
              WHERE s.isActive = 1 AND s.companyId IS NOT NULL 
              GROUP BY s.companyId, c.name 
              ORDER BY COUNT(s.id) DESC LIMIT 5
            `),
            db.query('SELECT COUNT(*) as totalDocuments FROM Document WHERE isActive = 1'),
            db.query('SELECT documentType, COUNT(*) as count FROM Document WHERE isActive = 1 GROUP BY documentType'),
            db.query('SELECT COUNT(*) as verifiedDocuments FROM Document WHERE isActive = 1 AND isVerified = 1'),
            db.query('SELECT COUNT(*) as totalCustomsRecords FROM CustomsClearance WHERE isActive = 1'),
            db.query('SELECT clearanceStatus, COUNT(*) as count FROM CustomsClearance WHERE isActive = 1 GROUP BY clearanceStatus'),
            db.query('SELECT SUM(dutyAmount) as dutyAmount, SUM(assessmentValue) as assessmentValue FROM CustomsClearance WHERE isActive = 1'),
            db.query('SELECT COUNT(*) as totalLogistics FROM Logistics WHERE isActive = 1'),
            db.query('SELECT status, COUNT(*) as count FROM Logistics WHERE isActive = 1 GROUP BY status'),
            db.query('SELECT COUNT(*) as unreadNotifications FROM Notification WHERE isRead = 0'),
            db.query('SELECT COUNT(*) as totalNotifications FROM Notification'),
            db.query(`
              SELECT s.id, s.shipmentNumber, s.bookingNumber, s.shippingLine, s.vesselName, 
                     s.originCountry, s.originPort, s.destinationPort, s.status, s.priority, 
                     s.etd, s.eta, s.currency, s.createdAt,
                     c.name as companyName
              FROM Shipment s LEFT JOIN Company c ON s.companyId = c.id
              WHERE s.isActive = 1 ORDER BY s.createdAt DESC LIMIT 6
            `),
            db.query(`
              SELECT a.*, u.name as userName, u.avatar as userAvatar 
              FROM Activity a LEFT JOIN User u ON a.userId = u.id 
              ORDER BY a.createdAt DESC LIMIT 10
            `),
            db.query('SELECT shippingLine, COUNT(*) as count FROM Shipment WHERE isActive = 1 AND shippingLine IS NOT NULL GROUP BY shippingLine ORDER BY count DESC'),
            db.query('SELECT originCountry as country, COUNT(*) as count FROM Shipment WHERE isActive = 1 AND originCountry IS NOT NULL GROUP BY originCountry ORDER BY count DESC'),
            db.query(`
              SELECT destinationPort as port, COUNT(*) as count
              FROM Shipment WHERE isActive = 1 AND destinationPort IS NOT NULL
              GROUP BY destinationPort ORDER BY count DESC
            `),
            db.query(`
              SELECT COALESCE(e.name, s.exporterCompany, 'Unassigned') as supplier,
                     COUNT(*) as count
              FROM Shipment s LEFT JOIN ExporterCompany e ON s.exporterCompanyId = e.id
              WHERE s.isActive = 1
              GROUP BY COALESCE(e.name, s.exporterCompany, 'Unassigned')
              ORDER BY count DESC
            `),
            db.query(`
              SELECT EXTRACT(YEAR FROM createdAt)::int as year, COUNT(*) as shipments
              FROM Shipment WHERE isActive = 1
              GROUP BY EXTRACT(YEAR FROM createdAt) ORDER BY year
            `)
        ]);

        const formattedRecentShipments = recentShipments.map((s) => ({
            ...s,
            company: s.companyName ? { name: s.companyName } : null,
            companyName: undefined
        }));

        const formattedActivities = recentActivities.map((a) => ({
            ...a,
            user: a.userName ? { name: a.userName, avatar: a.userAvatar } : null,
            userName: undefined,
            userAvatar: undefined
        }));

        const monthRanges = [];
        for (let i = 5; i >= 0; i--) {
            const date = new Date();
            date.setMonth(date.getMonth() - i);
            const monthStart = new Date(date.getFullYear(), date.getMonth(), 1);
            const monthEnd = new Date(date.getFullYear(), date.getMonth() + 1, 0);
            monthRanges.push({ monthStart, monthEnd });
        }

        const monthlyTrendPromises = monthRanges.map(async ({ monthStart, monthEnd }) => {
            const [
                [{ count }]
            ] = await Promise.all([
                db.query('SELECT COUNT(*) as count FROM Shipment WHERE createdAt >= ? AND createdAt <= ?', [monthStart, monthEnd])
            ]);
            return {
                month: monthStart.toLocaleString('default', { month: 'short', year: '2-digit' }),
                shipments: count || 0,
            };
        });

        const monthlyTrend = await Promise.all(monthlyTrendPromises);
        return res.json({
            shipments: {
                total: totalShipments || 0,
                active: activeShipments || 0,
                atPol: atPolShipments || 0,
                inTransit: inTransitShipments || 0,
                atPod: atPodShipments || 0,
                customsClearance: customsClearanceShipments || 0,
                delivered: deliveredShipments || 0,
                deliveredThisMonth: deliveredThisMonth[0]?.count || 0,
                byStatus: shipmentsByStatus || [],
                byPriority: shipmentsByPriority || [],
                monthlyTrend,
                yearlyTrend,
                byShippingLine: shipmentsByShippingLine || [],
                byOriginCountry: shipmentsByOrigin || [],
                byPort: shipmentsByPort || [],
                bySupplier: shipmentsBySupplier || [],
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
