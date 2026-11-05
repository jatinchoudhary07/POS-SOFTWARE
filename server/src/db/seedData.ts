/**
 * Two Hearts Cafe menu (Tijara), copied from the printed menu card. Every item is vegetarian.
 *
 * An item has one price, so a dish sold in two sizes becomes two items,
 * e.g. "Veg Chowmein (Half)" and "Veg Chowmein (Full)". The size is part of the name,
 * so the kitchen sees it too.
 *
 * Fresh install: `npm run setup` loads this menu. Existing database: `npm run menu:load`.
 */
export interface SeedCategory {
  name: string;
  items: { name: string; description?: string; pricePaise: number; isVeg?: boolean; isAvailable?: boolean }[];
}

/** Rupees -> paise. */
const rs = (rupees: number) => rupees * 100;

const single = (rows: [string, number][]) => rows.map(([name, price]) => ({ name, pricePaise: rs(price) }));

/** One dish, two sizes -> two items, smaller size first. */
const sized = (labels: [string, string], rows: [string, number, number][]) =>
  rows.flatMap(([name, small, large]) => [
    { name: `${name} ${labels[0]}`, pricePaise: rs(small) },
    { name: `${name} ${labels[1]}`, pricePaise: rs(large) },
  ]);

const halfFull = (rows: [string, number, number][]) => sized(['(Half)', '(Full)'], rows);
const iceCream = (rows: [string, number, number][]) => sized(['', '+ Ice Cream'], rows).map((i) => ({ ...i, name: i.name.trim() }));

export const seedMenu: SeedCategory[] = [
  {
    name: 'Pizza',
    items: sized(
      ['(Medium)', '(Large)'],
      [
        ['Tomato Pizza', 79, 130],
        ['Capsicum Pizza', 89, 140],
        ['Onion Pizza', 89, 140],
        ['Margherita Pizza', 89, 140],
        ['Veg OTC Pizza', 89, 140],
        ['Mushroom Pizza', 99, 150],
        ['Corn Pizza', 110, 160],
        ['Paneer Pizza', 120, 170],
        ['Tandoori Pizza', 120, 180],
        ['Cheese Pizza', 150, 230],
        ['Cheese Burst Pizza', 150, 280],
        ['Farm House Pizza', 230, 299],
        ['Two Hearts Special Pizza', 249, 349],
      ],
    ),
  },
  {
    name: 'Burger',
    items: single([
      ['Aloo Tikki Burger', 40],
      ['Veg Burger', 50],
      ['Noodle Burger', 50],
      ['Double Tikki Burger', 70],
      ['Paneer Burger', 70],
      ['Cheese Burger', 80],
      ['Melt Down Burger', 80],
      ['Double Decker Burger', 90],
      ['Two Hearts Special Burger', 99],
    ]),
  },
  {
    name: 'Sandwich',
    items: single([
      ['Veg Sandwich', 80],
      ['Makhani Sandwich', 90],
      ['Veg Chilli Sandwich', 95],
      ['Tandoori Sandwich', 99],
      ['Paneer Sandwich', 109],
      ['Tandoori Paneer Sandwich', 119],
      ['Pahadi Sandwich', 119],
      ['Veg Cheese Sandwich', 130],
      ['Two Hearts Special Sandwich', 149],
    ]),
  },
  {
    name: 'Chowmein',
    items: halfFull([
      ['Veg Chowmein', 40, 80],
      ['Butter Veg Chowmein', 50, 100],
      ['Paneer Chowmein', 70, 120],
      ['Hakka Chowmein', 70, 110],
      ['Singapuri Chowmein', 80, 130],
      ['Two Hearts Special Chowmein', 90, 150],
    ]),
  },
  {
    name: 'Momos',
    items: halfFull([
      ['Veg Steam Momos', 50, 80],
      ['Veg Fry Momos', 60, 90],
      ['Kurkure Momos', 70, 120],
      ['Chilli Momos', 80, 120],
      ['Steam Paneer Momos', 70, 120],
      ['Fry Paneer Momos', 80, 130],
      ['Paneer Kurkure Momos', 80, 130],
      ['Tandoori Momos', 90, 140],
      ['Tandoori Afghani Momos', 99, 149],
    ]),
  },
  {
    name: 'Fries',
    items: halfFull([
      ['Simple French Fries', 40, 80],
      ['Peri Peri Fries', 50, 100],
      ['Salted French Fries', 45, 85],
      ['Loaded Cheese Fries', 70, 120],
    ]),
  },
  {
    name: 'Roll',
    // These prices are hard to read on the photo of the menu card: check them in Settings → Menu.
    items: single([
      ['Veg Roll', 60],
      ['Aloo Tikki Roll', 70],
      ['Veg Tikki Roll', 80],
      ['Tandoori Roll', 95],
      ['Paneer Roll', 100],
      ['Veg Cheese Roll', 110],
    ]),
  },
  {
    name: 'Italian',
    items: single([
      ['Garlic Bread', 90],
      ['Paneer Garlic Bread', 120],
      ['Cheese Garlic Bread', 150],
      ['Calzone Paneer', 120],
    ]),
  },
  {
    name: 'Pasta',
    items: halfFull([
      ['Red Sauce Pasta', 60, 100],
      ['White Sauce Pasta', 60, 100],
      ['Pink Sauce Pasta', 70, 110],
      ['Cheese Pasta', 70, 130],
      ['Corn & Cheese Pasta', 80, 140],
    ]),
  },
  {
    name: 'Chilli Potato',
    items: halfFull([
      ['Chilli Potato Dry', 60, 99],
      ['Chilli Potato Gravy', 70, 110],
      ['Chilli Paneer Dry', 90, 120],
      ['Chilli Paneer Gravy', 110, 140],
      ['Manchurian Dry', 50, 100],
      ['Manchurian Gravy', 90, 130],
      ['Honey Chilli Potato', 70, 110],
      ['Ginger Chilli', 70, 110],
      ['Mushroom', 60, 90],
      ['Mushroom Dry', 70, 109],
      ['Chilli Mushroom Dry', 75, 119],
      ['Chilli Mushroom Gravy', 80, 119],
    ]),
  },
  {
    name: 'Chaap',
    items: halfFull([
      ['Masala Chaap', 80, 130],
      ['Malai Chaap', 99, 150],
      ['Soya Chaap', 99, 179],
      ['Afghani Chaap', 110, 199],
      ['Tandoori Chaap', 120, 199],
      ['Paneer Tikka', 120, 240],
    ]),
  },
  {
    name: 'Soups',
    items: single([
      ['Hot n Sour Soup', 40],
      ['Manchow Soup', 40],
      ['Cream n Tomato Soup', 49],
      ['Sweet Corn Soup', 49],
      ['Noodle Thuppa Soup', 49],
    ]),
  },
  {
    name: 'Maggi',
    items: single([
      ['Plain Maggi', 50],
      ['Masala Maggi', 60],
      ['Veg Maggi', 70],
      ['Veg Cheese Maggi', 80],
    ]),
  },
  {
    name: 'Coffee',
    items: single([
      ['Hot Coffee', 50],
      ['Hot Chocolate', 70],
      ['Cold Coffee', 70],
      ['Cold Coffee with Ice Cream', 90],
      ['Cappuccino Coffee', 70],
      ['Caramel Cold Coffee', 99],
    ]),
  },
  {
    name: 'Shakes',
    items: iceCream([
      ['Vanilla Shake', 70, 90],
      ['Strawberry Shake', 80, 100],
      ['Butterscotch Shake', 80, 100],
      ['Chocolate Shake', 80, 100],
      ['KitKat Shake', 80, 110],
      ['Oreo Shake', 80, 100],
      ['Blackcurrant Shake', 90, 110],
      ['Badam Shake', 99, 100],
      ['Kaju Shake', 100, 119],
    ]),
  },
  {
    name: 'Fruit Shakes',
    items: iceCream([
      ['Banana Shake', 60, 80],
      ['Mango Shake', 60, 80],
      ['Papaya Shake', 60, 80],
      ['Chikoo Shake', 60, 80],
    ]),
  },
  {
    name: 'Mojito',
    items: single([
      ['Classic Mint Mojito', 50],
      ['Lemon Mojito', 60],
      ['Green Mint Mojito', 60],
      ['Blue Lagoon Mojito', 60],
      ['Watermelon Mojito', 60],
      ['Kala Khatta Mojito', 60],
    ]),
  },
  {
    name: 'Combo & Party',
    items: [
      { name: 'Combo 1: Cold Coffee + Aloo Tikki Burger', pricePaise: rs(110) },
      { name: 'Combo 2: French Fries + Veg Burger + Coke', pricePaise: rs(139) },
      { name: 'Combo 3: Pizza (Onion/Tomato) + Cold Coffee + French Fries (Full)', pricePaise: rs(229) },
      {
        name: 'Pizza Party',
        description: '3 Medium Tomato Pizza + Simple French Fries (Full) + 1 litre Coke',
        pricePaise: rs(359),
      },
    ],
  },
];

/** Cafe details printed on receipts. Address and phone are not on the menu card: fill them in under Settings. */
export const cafeDetails = {
  restaurantName: 'Two Hearts Cafe',
  addressLine: 'Tijara',
  receiptFooter: 'Food brings people together. Thank you, visit again! Instagram: @two_hearts_cafe_tijara',
};
