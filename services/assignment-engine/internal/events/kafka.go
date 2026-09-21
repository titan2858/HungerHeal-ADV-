package events

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/segmentio/kafka-go"
)

// ---------------------------------------------------------------------------
// Kafka consumption and publishing.
//
// This is the first CONSUMER in the project - every service so far has only
// produced. The consumer-group mechanics are what make the engine horizontally
// scalable: run three instances and Kafka hands each one a partition of
// donation.created, so they share the work without coordinating.
// ---------------------------------------------------------------------------

type Consumer struct {
	reader *kafka.Reader
}

func NewConsumer(brokers []string, groupID, topic string) *Consumer {
	return &Consumer{
		reader: kafka.NewReader(kafka.ReaderConfig{
			Brokers: brokers,
			GroupID: groupID,
			Topic:   topic,

			// With a GroupID set, kafka-go manages partition assignment and
			// offset commits. Two instances in the same group split the
			// partitions; two instances in DIFFERENT groups each get every
			// message - which is how notification-service and tracking-service
			// will both react to donation.assigned independently.
			MinBytes: 1,
			MaxBytes: 10e6,

			// Wait this long for a batch before returning what is available.
			// Low, because a donor is waiting and a cooling meal does not care
			// about batching efficiency.
			MaxWait: 500 * time.Millisecond,

			// Start from the beginning for a brand-new group, so donations
			// published while the engine was down are still processed rather
			// than skipped.
			StartOffset: kafka.FirstOffset,
		}),
	}
}

// Message is one Kafka record plus the handle needed to commit it.
type Message struct {
	Key     string
	Value   []byte
	Headers map[string]string
	raw     kafka.Message
}

// Fetch returns the next message WITHOUT committing its offset.
//
// Fetch-then-commit rather than auto-commit is the whole basis of not losing
// donations: the offset only advances after the work has actually been done. A
// crash mid-processing means the message is redelivered on restart, which is
// at-least-once delivery working as intended - and is exactly why consumers
// must be idempotent (Phase 6).
func (c *Consumer) Fetch(ctx context.Context) (*Message, error) {
	m, err := c.reader.FetchMessage(ctx)
	if err != nil {
		return nil, err
	}

	headers := make(map[string]string, len(m.Headers))
	for _, h := range m.Headers {
		headers[h.Key] = string(h.Value)
	}

	return &Message{Key: string(m.Key), Value: m.Value, Headers: headers, raw: m}, nil
}

// Commit marks the message as processed. Called only after the work succeeded.
func (c *Consumer) Commit(ctx context.Context, m *Message) error {
	return c.reader.CommitMessages(ctx, m.raw)
}

func (c *Consumer) Close() error { return c.reader.Close() }

// ------------------------------------------------------------- producer

type Producer struct {
	writer *kafka.Writer
}

func NewProducer(brokers []string) *Producer {
	return &Producer{
		writer: &kafka.Writer{
			Addr: kafka.TCP(brokers...),
			// The topic is set per message, since this producer writes to both
			// donation.assigned and donation.unassigned.
			Balancer: &kafka.Hash{}, // hash the key, so one donation = one partition
			// RequireAll means the broker acknowledges only once the write is
			// durable. The slower, correct choice: a donation assignment that
			// evaporates because a broker restarted is worse than a few extra
			// milliseconds.
			RequiredAcks: kafka.RequireAll,
			Async:        false,
			MaxAttempts:  5,
		},
	}
}

// Publish writes one event, keyed by donationId.
//
// The key is load-bearing: Kafka routes by key hash, so every event about one
// donation lands on the same partition and is therefore processed in order.
// Without it, donation.assigned and a later donation.timeout for the same
// donation could be handled out of sequence by different consumers.
func (p *Producer) Publish(ctx context.Context, topic, key string, payload any, traceID, eventID string) error {
	value, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("could not encode %s event: %w", topic, err)
	}

	return p.writer.WriteMessages(ctx, kafka.Message{
		Topic: topic,
		Key:   []byte(key),
		Value: value,
		Headers: []kafka.Header{
			{Key: "x-trace-id", Value: []byte(traceID)},
			{Key: "x-event-id", Value: []byte(eventID)},
		},
	})
}

func (p *Producer) Close() error { return p.writer.Close() }
