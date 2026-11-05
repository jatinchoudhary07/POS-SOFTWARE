import type { SeedCategory } from '../../src/db/seedData';

/** The original generic sample menu. Tests use it so their expected items and prices stay fixed. */
export const sampleMenu: SeedCategory[] = [
  {
    name: 'Starters',
    items: [
      { name: 'Paneer Tikka', description: 'Tandoor-grilled cottage cheese', pricePaise: 24000 },
      { name: 'Veg Spring Roll', pricePaise: 16000 },
      { name: 'Chicken 65', description: 'Spicy fried chicken', pricePaise: 26000, isVeg: false },
      { name: 'Hara Bhara Kebab', pricePaise: 18000 },
      { name: 'Fish Amritsari', pricePaise: 32000, isVeg: false, isAvailable: false },
    ],
  },
  {
    name: 'Main Course',
    items: [
      { name: 'Paneer Butter Masala', pricePaise: 28000 },
      { name: 'Dal Makhani', pricePaise: 22000 },
      { name: 'Butter Chicken', pricePaise: 34000, isVeg: false },
      { name: 'Kadai Veg', pricePaise: 24000 },
      { name: 'Mutton Rogan Josh', pricePaise: 42000, isVeg: false },
    ],
  },
  {
    name: 'Breads',
    items: [
      { name: 'Tandoori Roti', pricePaise: 3000 },
      { name: 'Butter Naan', pricePaise: 5000 },
      { name: 'Garlic Naan', pricePaise: 6000 },
      { name: 'Laccha Paratha', pricePaise: 5500 },
    ],
  },
  {
    name: 'Rice & Biryani',
    items: [
      { name: 'Jeera Rice', pricePaise: 16000 },
      { name: 'Veg Biryani', pricePaise: 26000 },
      { name: 'Chicken Biryani', pricePaise: 32000, isVeg: false },
      { name: 'Steamed Rice', pricePaise: 12000 },
    ],
  },
  {
    name: 'Beverages',
    items: [
      { name: 'Masala Chai', pricePaise: 4000 },
      { name: 'Sweet Lassi', pricePaise: 8000 },
      { name: 'Fresh Lime Soda', pricePaise: 7000 },
      { name: 'Mineral Water', pricePaise: 2000 },
      { name: 'Cold Coffee', pricePaise: 12000, isAvailable: false },
    ],
  },
  {
    name: 'Desserts',
    items: [
      { name: 'Gulab Jamun (2 pcs)', pricePaise: 9000 },
      { name: 'Rasmalai', pricePaise: 11000 },
      { name: 'Kulfi', pricePaise: 9500 },
    ],
  },
];
