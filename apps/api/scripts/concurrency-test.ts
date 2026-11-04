import axios from 'axios';

const API_URL = 'http://localhost:4000/api';

async function runConcurrencyTest() {
  console.log('--- STARTING CONCURRENCY LOAD TEST ---');
  
  // Test 1: 20 Customers submitting intake form at the EXACT same time
  console.log('1. Testing Concurrent Intakes (20 users)...');
  const intakeRequests = Array.from({ length: 20 }).map((_, i) => 
    axios.post(`${API_URL}/repairs`, {
      customer: { name: `LoadTester ${i}`, phone: `08000000${i.toString().padStart(2, '0')}` },
      machine: { brand: 'La Marzocco', model: 'Linea Mini' },
      symptomIds: [1],
      receptionistId: 1
    })
    .then(r => r.data)
    .catch(e => e.response?.data || e.message)
  );

  const intakeResults = await Promise.all(intakeRequests);
  const successIntakes = intakeResults.filter(r => r.status === 'success');
  console.log(`Intake Success: ${successIntakes.length}/20`);
  const failedIntakes = intakeResults.filter(r => r.status !== 'success');
  if (failedIntakes.length > 0) {
    console.log('Failed Intake Count:', failedIntakes.length);
    console.log('Sample Intake Error:', failedIntakes[0]);
  }

  // Test 2: 5 Technicians changing status to AVAILABLE at the exact same time (Auto-Queue Assignment Race Condition)
  console.log('2. Testing Concurrent Queue Assignment (5 technicians)...');
  const queueRequests = Array.from({ length: 5 }).map((_, i) => 
    axios.patch(`${API_URL}/employees/${i + 2}/status`, { status: 'AVAILABLE' })
      .then(r => r.data)
      .catch(e => e.response?.data || e.message)
  );

  const queueResults = await Promise.all(queueRequests);
  const successQueue = queueResults.filter(r => r.status === 'success');
  console.log(`Queue Assignment Triggered: ${successQueue.length}/5`);
  if (successQueue.length === 0) console.log('First Queue Error:', queueResults[0]);

  console.log('--- TEST COMPLETE ---');
}

runConcurrencyTest();
