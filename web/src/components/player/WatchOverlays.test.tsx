import { describe, expect, mock, test } from "bun:test";
import { fakeTimers } from "../../test/fake-timers";
import { act, fireEvent, render, screen } from "../../test/interact";
import { RESUME_TOAST_MS, ResumeToast, UP_NEXT_COUNTDOWN_SEC, UpNext } from "./WatchOverlays";

describe("resumed at", () => {
  test("says where, offers Start over, and leaves on its own", () => {
    const clock = fakeTimers();
    const startOver = mock(() => {});
    render(<ResumeToast at={2530} onStartOver={startOver} timers={clock.timers} />);
    expect(screen.getByRole("status").textContent).toContain("Resumed at 42:10");
    act(() => clock.advance(RESUME_TOAST_MS));
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("Start over seeks to the top", () => {
    const clock = fakeTimers();
    const startOver = mock(() => {});
    render(<ResumeToast at={2530} onStartOver={startOver} timers={clock.timers} />);
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    expect(startOver).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("up next", () => {
  test("appears in the credits without playing, and counts down only once the episode has ended", () => {
    const clock = fakeTimers();
    const onPlay = mock(() => {});
    const { rerender } = render(
      <UpNext
        label="S1E4 · Episode 4"
        remainingSec={60}
        ended={false}
        onPlay={onPlay}
        timers={clock.timers}
      />,
    );
    expect(screen.queryByRole("region", { name: "Up next" })).toBeNull();

    rerender(
      <UpNext
        label="S1E4 · Episode 4"
        remainingSec={15}
        ended={false}
        onPlay={onPlay}
        timers={clock.timers}
      />,
    );
    expect(screen.getByRole("region", { name: "Up next" }).textContent).toContain("S1E4 · Episode 4");
    act(() => clock.advance(60_000));
    expect(onPlay).not.toHaveBeenCalled();

    rerender(
      <UpNext label="S1E4 · Episode 4" remainingSec={0} ended={true} onPlay={onPlay} timers={clock.timers} />,
    );
    expect(screen.getByText(`Playing in ${UP_NEXT_COUNTDOWN_SEC} s`)).toBeTruthy();
    // A second at a time: each tick schedules the next from the moment it fires, which one big
    // `advance` would place after the window it is walking.
    for (let s = 1; s < UP_NEXT_COUNTDOWN_SEC; s++) act(() => clock.advance(1_000));
    expect(screen.getByText("Playing in 1 s")).toBeTruthy();
    expect(onPlay).not.toHaveBeenCalled();
    act(() => clock.advance(1_000));
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  test("Cancel dismisses it and nothing plays", () => {
    const clock = fakeTimers();
    const onPlay = mock(() => {});
    render(
      <UpNext label="S2E1 · Episode 1" remainingSec={0} ended={true} onPlay={onPlay} timers={clock.timers} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    act(() => clock.advance(30_000));
    expect(onPlay).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Up next" })).toBeNull();
  });

  test("Play now plays at once", () => {
    const onPlay = mock(() => {});
    render(<UpNext label="S2E1 · Episode 1" remainingSec={10} ended={false} onPlay={onPlay} />);
    fireEvent.click(screen.getByRole("button", { name: "Play now" }));
    expect(onPlay).toHaveBeenCalledTimes(1);
  });
});
