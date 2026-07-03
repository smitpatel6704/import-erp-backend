import axios from "axios";

async function testAPI() {
  try {
    const { data } = await axios.get(
      "https://tracking.api.hlag.cloud/api/tracking/events?reference=29245713",
      {
        headers: {
          Accept: "application/json",
          "x-token": "public"
        }
      }
    );

    data.groups.forEach((group) => {
      console.log("\n========================");
      console.log("Container:", group.containerNumber);
      console.log("========================");

      group.events.forEach((event) => {
        console.log(
          `${event.eventDate} ${event.eventTime} | ${event.eventDescription} | ${event.eventLocation}`
        );
      });
    });
  } catch (error) {
    console.log(error.response?.data || error.message);
  }
}

testAPI();