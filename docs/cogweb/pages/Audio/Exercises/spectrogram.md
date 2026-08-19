---
jupyter:
  jupytext:
    notebook_metadata_filter: nbsphinx,-kernelspec
    text_representation:
      extension: .md
      format_name: markdown
      format_version: '1.3'
      jupytext_version: 1.13.8
  nbsphinx:
    execute: never
---

<!-- #raw raw_mimetype="text/restructuredtext" -->
.. meta::
    :description: Topic: Audio Processing, Category: Exercises
    :keywords: spectrogram, audio, temporal, fourier
<!-- #endraw -->

# Exercise: Creating Our Own Spectrogram

In this notebook we will learn how to create our own **spectrogram**.
A spectrogram is a visual representation of the prominent frequencies in audio samples *as they vary in time*.
That is, whereas plotting the the Fourier spectrum of a signal tells us what frequencies are prominent in the signal, a spectrogram will tell us what frequencies are prominent at any given time.
This is an extremely powerful tool for signal analysis.


```python
# run this cell (maybe twice to get %matplotlib notebook to work)
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.mlab as mlab
from microphone import record_audio
from typing import Tuple

%matplotlib notebook
```

## Accessing Time *and* Frequency: Building an Intuition for Spectrograms


Thus far we have seen two means for representing audio data visually. We have plotted:
1. Amplitude vs Time: Shows how the pressure from the sound wave varies over time.
2. Fourier Spectrum: Reveals the prominent frequencies that are present in the sound wave.

Let's revisit the clip of a trumpet playing a chord that we studied before.

```python
import librosa

# `recorded_audio` is a numpy array of N audio samples
recorded_audio, sampling_rate = librosa.load("data/trumpet.wav", sr=44100, mono=True)
```

Let's play this audio clip to recall what is being played.

```python
from IPython.display import Audio
Audio(recorded_audio, rate=sampling_rate)
```

### Revisiting the Fourier Spectrum


We'll plot both the temporal wave form/amplitude and its Fourier spectrum.
We will plot the Fourier coefficients, $|a_{k}|$, on a *log-scale*.
This is a natural scale to plot the Fourier spectrum on, as the human ear responds to loudness on a logarithmic scale (thus the common unit of "loudness", decibels [dB], used in audio science is a logarithmic scale).

```python
fig, (ax0, ax1) = plt.subplots(ncols=2, figsize=(8, 4))

# Compute the times at which each sample was recorded in seconds

# Define the following variable(s)
# `time`: array storing t_0, t_1, ..., t_{N-1} 
time = np.arange(len(recorded_audio)) / sampling_rate  # <COGLINE>

# Plotting the waveform (every 100th datapoint for sake of efficiency)
ax0.plot(time[::100], recorded_audio[::100])  
ax0.set_xlabel("Time [seconds]")
ax0.set_ylabel("Proportional to Pressure")
ax0.set_title("Temporal Waveform")
ax0.grid(True)


# Plotting the Fourier spectrum

# Compute the real-valued Fourier coefficents for this recording
# and the corresponding frequencies (in Hz)

# Define the following variable(s)
# `ak`: array storing the real-valued Fourier coeffs: a_0, a_1, ..., a_{N//2}
# `fk`: array storing the associated frequencies: 0/T, 1/T, ..., (N//2)/T

# <COGINST>
N = len(recorded_audio)
T = N / sampling_rate  # total time-span of audio clip

# FFT: yn -> ck
ck = np.fft.rfft(recorded_audio)  # complex-valued Fourier coefficients

# convert ck (complex Fourier coeff) -> |ak| (real-valued coeff)
ak = np.abs(ck) / N
ak[1 : (-1 if N % 2 == 0 else None)] *= 2

# convert k = 0, 1, ... to freq = 0, 1/T, 2/T, ..., (int(N/2))/T
fk = np.arange(len(ak)) / T
# </COGINST>

ax1.plot(fk[:20000], ak[:20000])
ax1.set_title("Fourier Spectrum")
ax1.set_xlabel("Frequency [Hz]")
ax1.set_ylabel("Proportional to decibels [dB]")
ax1.grid(True)
ax1.set_yscale("log")
fig.tight_layout()
```

### Comparing a Fourier Spectrum to a Spectrogram


See that there is a trade-off between these two representations of the data.
That is, from the waveform we can see that the trumpet is playing a relatively sustained chord for about $2.5$ seconds, while we cannot glean from the wave form what notes are being played.
The Fourier spectrum reveals very clear information about the notes being played, but reveals nothing about the duration or ordering of the notes (are they being played in unison? in sequence? for how long? etc.).

We would like to know *what pure tone frequencies* are prominent in our signal and *when* they occur in our signal.
A **spectrogram** plots exactly this information. Without further ado, let's use matplotlib's built-in spectrogram function to understand what this visualization represents:

```python
# using matplotlib's built-in spectrogram function
import matplotlib.mlab as mlab

fig, ax = plt.subplots()

S, freqs, times, im = ax.specgram(
    recorded_audio,
    NFFT=4096,
    Fs=sampling_rate,
    window=mlab.window_hanning,
    noverlap=4096 // 2,
    mode='magnitude',
    scale="dB"
)
fig.colorbar(im)

ax.set_xlabel("Time [seconds]")
ax.set_ylabel("Frequency (Hz)")
ax.set_title("Spectrogram of Recording")
ax.set_ylim(0, 4000);
```

The spectrogram displays a heat map which reflects the magnitude (i.e. absolute value) of the Fourier coefficients for a given time and frequency.
For example the yellow horizontal streak near $1000\;\mathrm{Hz}$ indicates that this frequency is prominent throughout the duration of the signal.
Note that this spectrogram function is automatically plotting these magnitudes on a log-scale, for the reasons discussed earlier.
This plot reveals that the prominent notes are being played in unison, and sustained for roughly $2.5$ seconds. We can also easily read off the frequencies of these notes and their [overtones](https://en.wikipedia.org/wiki/Overtone).


(1.7.1) Create the function, `plot_recording`, that:

- Accepts a time-length, in seconds 
- Uses `microphone.record_audio` to record audio for that duration of time. Recall that this returns "frames" of audio data and the microphone's sampling rate. (Refer to the `WorkingWithMic` notebook for reference)
- Converts the "frames" of audio data to a numpy array of 16-bit samples, using `np.hstack([np.frombuffer(i, np.int16) for i in frames])`
- Uses `mlab.specgram` to plot the spectrogram for that recording, given those 16-bit samples and the microphone's sampling rate
- Returns the matplotlib `Figure` and `Axes` object instances that were produced by the plot

Set the $y$-limit of the plot to have an upper bound of $10,000\;\mathrm{Hz}$.
Don't change any of the spectrogram settings other than the audio samples that you pass in and the sampling rate of the microphone.

```python
def plot_recording(time: float) -> Tuple[plt.Figure, plt.Axes]:
    """ 
    Record audio and plot its spectrogram.
    
    Parameters
    ----------
    time : float
        The duration (seconds) to record audio for
    
    Returns
    -------
    fig, ax
        The plot objects for the spectrogram"""
    # <COGINST>
    frames, sample_rate = record_audio(time)
    data = np.hstack([np.frombuffer(i, np.int16) for i in frames])

    # using matplotlib's built-in spectrogram function
    fig, ax = plt.subplots()

    S, freqs, times, im = ax.specgram(
        data,
        NFFT=4096,
        Fs=sampling_rate,
        window=mlab.window_hanning,
        noverlap=4096 // 2,
        mode='magnitude'
    )
    ax.set_ylim(0, 10000)
    ax.set_xlabel("time (sec)")
    ax.set_ylabel("frequency (Hz)")
    return fig, ax
    # </COGINST>
```

To continue building our intuition for the spectrogram, use `microphone.record_audio` to record a $5$ second clip of yourself whistling, clapping, etc.
Try varying the pitch, rhythm, etc. during the clip. Plot the clip as a spectrogram. 

```python
plot_recording(5); # <COGLINE>
```

You should see that the spectrogram successfully captures both the prominent frequencies present in the signal and their dynamics in time. Try plotting several recordings where you whistle, clap, sing, etc. Can you see the correspondence between the sounds that you made and the patterns that manifest in the spectrogram?

Let's appreciate that we now have access to both frequency data and time data! This is extremely useful! Now how exactly is this working?

<!-- #region -->
## Digging into Spectrograms

Our full recording consists of $N_\mathrm{total}$ audio samples $(y_{n})_{n=0}^{N_\mathrm{total}-1}$ recorded over a duration $T$ with some sampling rate $f_s$.

A spectrogram is constructed simply by dividing your samples into $M$ temporal windows, each of time-length $\Delta t$ and consisting of $N$ samples, where $N$ is determined by the duration $\Delta t$ and $f_s$: $N = \Delta t f_s$. 

\begin{equation}
\big\{(y_{n})_{n=0}^{N_\mathrm{total}-1}\big\}_{T} \Longrightarrow
\begin{bmatrix}
    \leftarrow   &  \big\{(y_{n})_{n=0}^{N-1}\big\}_{\Delta t_{0}} & \rightarrow  \\
    \leftarrow   &  \big\{(y_{n})_{n=0}^{N-1}\big\}_{\Delta t_{1}}  & \rightarrow \\
    & \vdots  &\\
    \leftarrow   &  \big\{(y_{n})_{n=0}^{N-1}\big\}_{\Delta t_{M-1}} & \rightarrow  \\
\end{bmatrix}
\end{equation}

We perform a discrete Fourier transform on the collection of samples for each given window.
This produces $M$ Fourier spectra – one for each temporal window's audio samples; this makes up each column of numbers in the spectrogram:

\begin{equation}
\begin{bmatrix}
    \leftarrow   &  \big\{(y_{n})_{n=0}^{N-1}\big\}_{\Delta t_{0}} & \rightarrow  \\
    \leftarrow   &  \big\{(y_{n})_{n=0}^{N-1}\big\}_{\Delta t_{1}} & \rightarrow \\
    & \vdots  &\\
    \leftarrow   &  \big\{(y_{n})_{n=0}^{N-1}\big\}_{\Delta t_{M-1}} & \rightarrow  \\
\end{bmatrix} 
\Longrightarrow 
\begin{bmatrix}
    \leftarrow   &  \big\{(c_{k})_{k=0}^{\lfloor N/2 \rfloor}\big\}_{\Delta t_{0}} & \rightarrow  \\
    \leftarrow   &  \big\{c_{k})_{k=0}^{\lfloor N/2 \rfloor}\big\}_{\Delta t_{1}}  & \rightarrow \\
    & \vdots  &\\
    \leftarrow   &  \big\{c_{k})_{k=0}^{\lfloor N/2 \rfloor}\big\}_{\Delta t_{M-1}} & \rightarrow  \\
\end{bmatrix} \Longrightarrow 
\begin{bmatrix}
    \leftarrow   &  \big\{(|a_{k}|)_{k=0}^{\lfloor N/2 \rfloor}\big\}_{\Delta t_{0}} & \rightarrow  \\
    \leftarrow   &  \big\{|a_{k}|)_{k=0}^{\lfloor N/2 \rfloor}\big\}_{\Delta t_{1}}  & \rightarrow \\
    & \vdots  &\\
    \leftarrow   &  \big\{|a_{k}|)_{k=0}^{\lfloor N/2 \rfloor}\big\}_{\Delta t_{M-1}} & \rightarrow  \\
\end{bmatrix} 
\end{equation}



If each temporal-window of our digital audio signal contains $N$ samples, then the Fourier transform on each window will produce $\left\lfloor\frac{N}{2}\right\rfloor + 1$ Fourier coefficients $(|a_{k}|)_{k=0}^{\lfloor N/2\rfloor}$.
Remember that we are interested in the *amplitude* of each Fourier coefficient, not its complex value, for the spectrogram.
This allows us to know what the frequency distribution is in our signal during each time-interval (a.k.a temporal window). 
The time window starts at $m\Delta t$ and ends at $(m+1)\Delta t$, for $m \in [0, 1, \dots, M-1]$.

**The *transpose* of the depicted array is what we plot in the spectrogram**: each column corresponds to one of $M$ temporal windows, and stores the Fourier spectrum of the audio recording during that time-interval.


The following function produces the same spectrogram as was plotted above, but without producing the associated plot;
let's get the spectrogram for the audio recording:
<!-- #endregion -->

```python
# obtaining the spectrogram for the trumpet wave form (again)

sampling_rate = 44100  # sampling rate in Hz

S, freqs, times = mlab.specgram(
    recorded_audio,
    NFFT=4096,
    Fs=sampling_rate,
    window=mlab.window_hanning,
    noverlap=int(4096 / 2),
    mode='magnitude'
)
```

`S` is the spectrogram, the 2-D array whose rows corresponds to frequencies and whose columns correspond to time.
`freqs` is an array of the frequency values corresponding to the rows, and `times` is an array of time values corresponding to the columns. Their units are Hz and seconds, respectively.

(1.7.2) Inspect the shapes of these arrays.
How many time bins, $M$, were used in the spectrogram?
How many frequency values are present in each time-bin?
Verify that the shape of `S` corresponds with the lengths of `freqs` and `times`.

```python
# <COGINST>
print(
    f"S.shape is {S.shape}, thus there are {S.shape[1]} time bins and {S.shape[0]} frequencies represented."
)
assert S.shape == (len(freqs), len(times))
# </COGINST>
```

What are the sizes of the frequency bins (in Hz)?
Of the time bins (in seconds)?
Are the bins (nearly) uniform in size?

```python
# <COGINST>
print(f"Frequency bin-sizes (Hz): {np.diff(freqs)}")
print(f"Time bin-sizes (seconds): {np.diff(times)}")
# </COGINST>
```

Assign `recorded_dt` to the amount of time covered by each temporal window (i.e. a single float)

```python
recorded_dt = np.diff(times)[0]  # <COGSTUB>
```

## Creating Your Own Spectrogram

### Learning About the Sliding Window Function

`mygrad` comes with a sliding window function; this creates windowed *views* of an array at regular intervals.
Import `sliding_window_view` from `mygrad` and read its docstring or [its documentation page](https://mygrad.readthedocs.io/en/latest/generated/mygrad.sliding_window_view.html#mygrad.sliding_window_view).
This will be handy for when we create $M$ windows of our audio sample data.

```python
from mygrad import sliding_window_view

help(sliding_window_view)
```

<!-- #region -->
(1.7.3) Now let's create a 1-D NumPy array containing the integers from $0$ to $11$.
Use `sliding_window_view` to make the following windowed views:

- window size: 2, stride: 1
- window size: 2, stride: 2
- window size: 3, stride: 2
- window size: 6, stride: 3
- window size: 6, stride: 6

Note that `sliding_window_view` doesn't accept a window *size* but rather a window *shape*.
Thus if you want to make a 1-D window of size $2$ applied with a step-size of $1$, you would specify

```python
sliding_window_view(arr, window_shape=(2,), step=1)
```
<!-- #endregion -->

Run the following cell and look at the outputs to develop an intuition for how this sliding window view function works.

```python
from mygrad import sliding_window_view

arr = np.arange(11)

# A row of the array stores a single window of the data.
# The number of rows is thus the number of windows formed.
# The number of columns is the length of each window.

print(f"original data: {arr}\n")

for window_size, step in zip((2, 2, 3, 6, 6), (1, 2, 2, 3, 6)):
    print(f"\nData viewed with a window-size of {window_size}, step-size of {step}:")
    print(sliding_window_view(arr, window_shape=(window_size,), step=step))
```

Study the shape and contents of the windowed arrays that you produce here.
What do the axes of the resulting array correspond to?
Note that this function does not make any copies of our data; it creates "views" of the underlying data!
Feel free to play with this function to further develop your intuition.
Discuss your observations with your neighbor.


(1.7.4) Now use `sliding_window_view` to create **non-overlapping** time windows of the trumpet audio signal.
Determine the appropriate window size, $N$, so as to roughly match the spectrogram that we created above (based on its $\Delta t$).
That is, make sure each of your windows include the appropriate number of samples so that your $\Delta t$ matches matplotlib's.

```python
# The desired temporal duration (seconds) of each window of audio data
window_dt = recorded_dt  # you can adjust this value later


# Compute the number of samples, N, that should fit in each
# window, so that each temporal window has a duration of `window_dt`
# Hint: remember that the audio samples have an associated
# sampling rate of 44100 samples per second

# Define this as `window_size` (an int)
# <COGINST>
window_size = int(window_dt * 44100)
# </COGINST>

# Using the above window size and `sliding_window_view`, create an array 
# of non-overlapping windows of the audio data.
# What should the step-size be so that the windows are non-overlapping?
#
# Define `windowed_audio` to be a 2D array where each row contains the
# samples of the recording in a temporal window.
# The shape should be (M, N), where M is the number of temporal windows
# and N is the number of samples in each window
# <COGINST>
windowed_audio = sliding_window_view(recorded_audio, window_shape=(window_size,), step=window_size)
# </COGINST>
```

Look at the shape of your array. How many time windows did you create; i.e. what is $M$ equal to?
How many samples, $N$, reside in each window?
Thus what is the time duration of each window?

```python
# <COGINST>
M, N = windowed_audio.shape
print(f"Number of temporal windows (M): {M}")
print(f"Number of samples in each window (N): {N}")
# <COGINST>
```

<!-- #region -->
Now take the discrete Fourier transform, using `np.fft.rfft`,  over each time window.
Note that `np.fft.rfft` accepts an `axis` argument, such that you can apply this operation across the rows (`axis=0`) or across the columns (`axis=1`) of 2D arrays of data.
Set the `axis` value so that the FFT is applied to the samples within each time-window separately.
I.e. a total of $M$ FFTs should be performed by this single function call.


Take the absolute value of the output to convert the complex-valued Fourier coefficients into real-valued magnitudes.
You can convert the 2D array of complex-valued coefficients to real-values amplitudes using:

```python
# ck_for_each_window is a shape-(M, N//2 + 1) array of complext-valued Fourier coeffs
ak_for_each_window = np.absolute(ck_for_each_window) / N
ak_for_each_window[:, 1 : (-1 if N % 2 == 0 else None)] *= 2
```
<!-- #endregion -->

```python
# <COGINST>
ck_for_each_window = np.fft.rfft(windowed_audio, axis=1)
ak_for_each_window = np.absolute(ck_for_each_window) / N
ak_for_each_window[:, 1 : (-1 if N % 2 == 0 else None)] *= 2
# </COGINST>
```

Do the rows and columns of the array that you have just computed correspond to what we want for our spectrogram? That is, do our rows correspond to frequencies, and columns correspond to times?
Update your array so that they do, and store the result in an array called `spectrogram`.

```python
spectrogram = ak_for_each_window.T  # <COGSTUB> rows: freq, cols: time
```

Compute the duration of the *full* audio signal in seconds, given that the sampling rate used to record it was $44,100\;\mathrm{Hz}$.
Assign this to `T`.

```python
T = len(recorded_audio) / 44100 # <COGLINE>
```

Compute the maximum frequency included in the Fourier spectrum for any of the given temporal windows. 
Assign this float value to `F`.

```python
F = (window_size // 2 + 1) / window_dt # <COGLINE>
```

Time to plot our spectrogram!
We will make use of `T` and `F` to set the scales for our plot axes, and to set a sensible aspect ratio for the plot.

```python
# Plug your spectrogram array in `imshow` and execute this cell
# notes that we set `origin="lower"` in the `imshow function, this is
# so the low frequencies occur at the bottom of the y axis; this is flipped
# from how your array is structured

max_freq = 4000  # the largest frequency that we want to plot

# this is used to set the (left, right, bottom, top) scale for the image axes
extent = (0, T, 0, F)
aspect_ratio = T / max_freq

fig, ax = plt.subplots()
ax.imshow(
    np.log(spectrogram),
    origin="lower",
    aspect=aspect_ratio,
    extent=extent,
    interpolation="bilinear",
)
ax.set_ylim(0, max_freq)

ax.set_xlabel("Time (sec)")
ax.set_ylabel("Frequency (Hz)")
```

Notice that, to mimic the original spectrogram plot, we are plotting the *logarithm* of the Fourier amplitudes, so that the spectrogram's heat map values correspond to audible decibels.


This plot should resemble that of the original spectrogram quite closely.
There are some special considerations to take in order to ensure that the boundaries between time bins are handled well – not accounting for these introduces significant artifacts into the spectrogram.
Matplotlib's spectrogram looks much cleaner than ours because they use nice techniques, like the application of a "hamming window", to stitch together the Fourier spectra over time.

At its core though, a spectrogram is as simple as applying a Fourier transform on time-windowed bins of the signal, and plotting the resulting Fourier coefficient amplitudes as the columns of a frequency vs time plot, with each column corresponding to a time window of the signal.

- col-0 : Fourier spectrum of signal during $\Delta t_0$ 
- col-1 : Fourier spectrum of signal during $\Delta t_1$ 
- $\vdots$


To improve the quality of your spectrogram, you can try doubling the window size, but keeping the same stride.
Thus the windows will partially overlap, which will help to mitigate the effects of the artificial boundaries that we introduced in our windowing. 
