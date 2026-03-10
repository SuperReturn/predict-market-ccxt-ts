// // betfair-place-order.ts
// // Example: Place a BACK £2 @ 3.0 limit order on Betfair Exchange (LAPSE mode)

// const APP_KEY = "your Application Key";
// const SESSION_TOKEN = "your session token";
// const MARKET_ID = "1.234567890";       // Replace with real marketId
// const SELECTION_ID = 12345678;         // Replace with real selectionId
// const PRICE = 3.00;
// const SIZE = 2.00;

// const ENDPOINT = "https://api.betfair.com/exchange/betting/json-rpc/v1";

// const headers = {
//   "X-Application": APP_KEY,
//   "X-Authentication": SESSION_TOKEN,
//   "Content-Type": "application/json",
//   "Accept": "application/json",
// };

// const payload = {
//   jsonrpc: "2.0",
//   method: "SportsAPING/v1.0/placeOrders",
//   params: {
//     marketId: MARKET_ID,
//     instructions: [
//       {
//         selectionId: SELECTION_ID,
//         handicap: 0,
//         side: "BACK",                    // Change to "LAY" if needed
//         orderType: "LIMIT",
//         limitOrder: {
//           size: SIZE,
//           price: PRICE,
//           persistenceType: "LAPSE",      // LAPSE = cancel if not matched
//         },
//       },
//     ],
//   },
//   id: 1,
// };

// async function placeBet() {
//   try {
//     const response = await fetch(ENDPOINT, {
//       method: "POST",
//       headers,
//       body: JSON.stringify(payload),
//     });

//     if (!response.ok) {
//       throw new Error(`HTTP error! status: ${response.status}`);
//     }

//     const data = await response.json();

//     console.log("Place order response:");
//     console.log(JSON.stringify(data, null, 2));

//     if (data.error) {
//       console.error("API Error:", data.error);
//       return;
//     }

//     const result = data.result;
//     if (result?.status === "SUCCESS") {
//       const betId = result.instructionReports?.[0]?.betId;
//       console.log(`Success! Bet ID: ${betId}`);
//     } else {
//       console.log("Order status:", result?.status);
//       if (result?.instructionReports?.[0]?.errorCode) {
//         console.log("Error code:", result.instructionReports[0].errorCode);
//       }
//     }
//   } catch (err) {
//     console.error("Request failed:", err);
//   }
// }

// // Run it
// placeBet();