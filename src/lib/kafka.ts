import { Kafka, Producer } from 'kafkajs'
import { env } from '../env.js'

const kafka = new Kafka({
  clientId: 'dapplepot-api',
  brokers: env.KAFKA_BOOTSTRAP_SERVERS.split(','),
})

let producer: Producer | null = null

export async function getProducer(): Promise<Producer> {
  if (!producer) {
    producer = kafka.producer()
    await producer.connect()
  }
  return producer
}

export async function sendKafkaMessage(
  topic: string,
  key: string,
  value: unknown
): Promise<void> {
  const p = await getProducer()
  await p.send({
    topic,
    messages: [{ key, value: JSON.stringify(value) }],
  })
}

export async function closeKafka(): Promise<void> {
  if (producer) {
    await producer.disconnect()
    producer = null
  }
}
