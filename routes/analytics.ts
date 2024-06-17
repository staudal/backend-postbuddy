import { Router } from 'express';
import { prisma } from '../app';
import { InternalServerError, MissingRequiredParametersError } from '../errors';

const router = Router();

router.get('/aov', async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

  try {
    const allOrders = await prisma.order.findMany({
      orderBy: {
        created_at: 'asc'
      },
      where: {
        user_id,
      },
      select: {
        email: true,
        created_at: true,
        amount: true
      }
    });

    // Organize orders by email
    const userOrders = allOrders.reduce((acc: { [key: string]: any[] }, order) => {
      const key = order.email;
      if (!acc[key]) {
        acc[key] = [];
      }
      acc[key].push(order);
      return acc;
    }, {});

    // Initialize revenue tracking
    let oneTimePurchase = { total: 0, count: 0 };
    let twoTimePurchase = { total: 0, count: 0 };
    let moreThanTwoPurchases = { total: 0, count: 0 };
    let overall = { total: 0, count: 0 };

    for (const email in userOrders) {
      const orders = userOrders[email];
      const orderCount = orders.length;

      // Calculate total revenue for each user
      const userTotal = orders.reduce((sum, order) => sum + order.amount, 0);
      overall.total += userTotal;
      overall.count += orderCount;

      if (orderCount === 1) {
        oneTimePurchase.total += userTotal;
        oneTimePurchase.count += orderCount;
      } else if (orderCount === 2) {
        twoTimePurchase.total += userTotal;
        twoTimePurchase.count += orderCount;
      } else if (orderCount > 2) {
        moreThanTwoPurchases.total += userTotal;
        moreThanTwoPurchases.count += orderCount;
      }
    }

    // Calculate AOVs
    const oneTimeAOV = oneTimePurchase.total / oneTimePurchase.count || 0;
    const twoTimeAOV = twoTimePurchase.total / twoTimePurchase.count || 0;
    const moreThanTwoAOV = moreThanTwoPurchases.total / moreThanTwoPurchases.count || 0;
    const overallAOV = overall.total / overall.count || 0;

    return res.status(200).json({
      oneTimeAOV,
      twoTimeAOV,
      moreThanTwoAOV,
      overallAOV
    });
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

router.get('/revenue-for-repeat-purchases', async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

  try {
    const allOrders = await prisma.order.findMany({
      orderBy: {
        created_at: 'asc'
      },
      where: {
        user_id
      },
      select: {
        email: true,
        created_at: true,
        amount: true
      }
    });

    // Organize orders by email
    const userOrders = allOrders.reduce((acc: { [key: string]: any[] }, order) => {
      const key = order.email;
      if (!acc[key]) {
        acc[key] = [];
      }
      acc[key].push(order);
      return acc;
    }, {});

    // Initialize a map to hold the revenue per month per category
    const monthlyRevenue: { [key: string]: { [key: string]: number } } = {};

    for (const email in userOrders) {
      const orders = userOrders[email];

      // Count orders per user
      const orderCount = orders.length;

      // Determine the category based on order count
      let category: string;
      if (orderCount === 1) {
        category = '1x purchase';
      } else if (orderCount === 2) {
        category = '2x purchase';
      } else {
        category = '+2x purchase';
      }

      // Process each order
      orders.forEach(order => {
        const month = new Date(order.created_at).toLocaleString('default', { month: 'short', year: 'numeric' });

        if (!monthlyRevenue[month]) {
          monthlyRevenue[month] = {
            '1x purchase': 0,
            '2x purchase': 0,
            '+2x purchase': 0
          };
        }

        monthlyRevenue[month][category] += order.amount;
      });
    }

    // Calculate percentages and format the result
    const result = Object.entries(monthlyRevenue).map(([month, categories]) => {
      const total = Object.values(categories).reduce((acc, value) => acc + value, 0);
      return {
        month,
        ...categories,
        '1x purchase (%)': (categories['1x purchase'] / total) * 100,
        '2x purchase (%)': (categories['2x purchase'] / total) * 100,
        '+2x purchase (%)': (categories['+2x purchase'] / total) * 100,
        totalRevenue: total
      };
    });

    // Sort the result by month
    const sortedResult = result.sort((a, b) => {
      const dateA = new Date(a.month);
      const dateB = new Date(b.month);
      return dateA.getTime() - dateB.getTime();
    });


    return res.status(200).json(sortedResult);
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

router.get('/time-between-purchases', async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

  try {
    const allOrders = await prisma.order.findMany({
      orderBy: {
        created_at: 'asc'
      },
      where: {
        user_id
      },
      select: {
        email: true,
        created_at: true
      }
    });

    // Organize orders by email
    const userOrders = allOrders.reduce((acc: { [key: string]: any }, order) => {
      const key = order.email; // Using email as the unique identifier for users
      if (!acc[key]) {
        acc[key] = [];
      }
      acc[key].push(order.created_at);
      return acc;
    }, {});

    // Calculate the time differences and intervals
    const intervals = [];

    for (const email in userOrders) {
      if (userOrders[email].length > 1) {
        const firstOrderTime = new Date(userOrders[email][0]).getTime();
        const secondOrderTime = new Date(userOrders[email][1]).getTime();
        const diffInDays = Math.floor((secondOrderTime - firstOrderTime) / (1000 * 60 * 60 * 24));
        const interval = Math.floor(diffInDays / 30);
        intervals.push(interval);
      }
    }

    // Count the number of orders in each interval
    const intervalCounts = intervals.reduce((acc: { [key: number]: number }, interval) => {
      if (!acc[interval]) {
        acc[interval] = 0;
      }
      acc[interval]++;
      return acc;
    }, {});

    // Calculate the total number of repeat orders
    const totalRepeatOrders = intervals.length;

    // Format the result
    const result = Object.entries(intervalCounts).map(([interval, count]) => {
      const intervalNumber = Number(interval);
      return {
        interval: `${intervalNumber * 30}-${intervalNumber * 30 + 29}`,
        number_of_orders: count,
        percentage_of_orders: (count / totalRepeatOrders) * 100
      };
    });

    return res.status(200).json(result);
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

export default router;