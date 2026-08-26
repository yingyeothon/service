.PHONY: help fmt analyze test build build-split clean deps all

help:
	@echo "Available targets:"
	@echo "  make fmt         - Format Dart code"
	@echo "  make analyze     - Run Flutter analyzer (lint)"
	@echo "  make test        - Run tests"
	@echo "  make build       - Build release APK"
	@echo "  make build-split - Build release APK split per ABI"
	@echo "  make clean       - Clean build artifacts"
	@echo "  make deps        - Get dependencies"
	@echo "  make all         - Run fmt, analyze, test, and build"

fmt:
	dart format lib/

analyze:
	flutter analyze

test:
	@if [ -d "test" ]; then \
		flutter test; \
	else \
		echo "No tests found, skipping..."; \
	fi

build:
	flutter build apk --release

build-split:
	flutter build apk --release --split-per-abi --target-platform android-arm64

clean:
	flutter clean

deps:
	flutter pub get

all: fmt analyze test build
