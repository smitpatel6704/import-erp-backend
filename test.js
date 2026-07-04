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

      // FIND ETA / PLANNED EVENT
      const eta = group.events.find(
        (e) => e.eventClassifierCode === "Planned"
      );

      console.log(
        "ETA:",
        eta
          ? `${eta.eventTransport}, ETA ${eta.eventDate}, ${eta.eventLocation}`
          : "No ETA Found"
      );

      console.log("\nEVENTS:");

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