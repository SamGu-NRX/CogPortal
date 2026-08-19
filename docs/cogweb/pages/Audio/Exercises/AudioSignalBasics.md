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
    :keywords: sound wave, pressure, audio basics, temporal waveform
<!-- #endraw -->

# Exercises: Basics of Sound Waves

```python
import matplotlib.pyplot as plt
import numpy as np

%matplotlib notebook
```

(1.1.1) Create a Python function that describes a pressure wave impinging on a microphone. 
Assume that the sound wave is a sustained, pure tone of frequency $f$ and amplitude $A$, and that $p(0) = 0$.
Note that this function represents our *temporal waveform*: the function that you create is defined on a continuous domain.
While this represents a continuous mathematical function, we must work with concrete numbers when plotting and analyzing these functions on a computer.
Thus we will evaluate this function at a discrete set of times.

Note that the following function signature makes use of [type hints](https://www.pythonlikeyoumeanit.com/Module5_OddsAndEnds/Writing_Good_Code.html#Type-Hinting). 
Furthermore, the arguments `amp` and `freq` come after the `*` character in the signature, which means that they are keyword-only arguments in our function. 
This is to prevent us from accidentally swapping numbers when we pass our numbers into it.

```python
def pressure(times: np.ndarray, *, amp: float, freq: float) -> np.ndarray:
    """Describes the temporal waveform of a pure tone impinging on a 
    microphone at times `times` (an array of times). The wave has 
    an amplitude `amp`, measured in Pascals, and a frequency 
    `freq`, measured in Hz.
    
    Parameters
    ----------
    times : numpy.ndarray, shape=(N,)
        The times at which we want to evaluate the sound wave
    
    amp : float
        The wave's amplitude (measured in Pascals - force per unit area)
    
    freq : float
        The wave's frequency (measured in Hz - oscillations per second)
    
    Returns
    -------
    numpy.ndarray, shape=(N,)
        The pressure at the microphone at times `t`

    Notes
    -----
    We only care about the wave at a fixed location, at the microphone, 
    which is why we do not have any spatial component to our wave. 
    """
    # 
    # <COGINST>
    return amp * np.sin(2 * np.pi * freq * times)
    # </COGINST>
```

<!-- #region -->
(1.1.2) As stated above, the function that you just wrote can be thought of as a representation of the temporal waveform that is recorded by our microphone: it represents the continuous fluctuations in air density associated with a sound wave.
We can "sample" this function by evaluating the function at specific times. 

Evaluate the temporal waveform for a $C_{4}$-note ($261.63 \:\mathrm{Hz}$) played for $3$ seconds with an amplitude of $0.06\:\mathrm{Pascals}$ **using the sampling rate 44100 Hz (samples per second)**.
That is, evaluate your function at evenly-spaced times according to this sampling rate for a time duration of $3$ seconds. 

You can compute the times at which you will evaluate your function using:

```python
duration = 3 # seconds
sampling_rate = 44100 # Hz
n_samples = int(duration * sampling_rate) + 1

# the times at which you should sample your temporal waveform
times = np.arange(n_samples) / sampling_rate  # seconds
```

You should ultimately produce an array, `c_4`, of pressure values associated with this pure tone.

Include comments where appropriate to indicate the physical units of measurements associated with the quantities involved.
<!-- #endregion -->

```python
# <COGINST>
amplitude = 0.01  # Pascals
duration = 3 # seconds
sampling_rate = 44100 # Hz
n_samples = int(duration * sampling_rate) + 1

times = np.arange(n_samples) / sampling_rate  # seconds
freq = 261.63  # Hz
c_4 = pressure(times, amp=amplitude, freq=freq)  # Pascals
# </COGINST>
```

<!-- #region -->
Play the $3$-second audio using

```python
from IPython.display import Audio
Audio(c_4, rate=44100)
```
Note that `Audio` automatically normalized the volume according to its slider, so the amplitude that we set will have no effect.
Adjusting the amplitude would typically manifest as a change in volume!
<!-- #endregion -->

```python
# <COGINST>
from IPython.display import Audio
Audio(c_4, rate=sampling_rate)
# </COGINST>
```

<!-- #region -->
(1.1.3) Using `pressure(...)`, plot **4 periods (repetitions) of the sound wave**. Label the $x$- and $y$-axes, including the units of the values being plotted.
Use enough points to make the plot look smooth.

Here is some pseudocode for plotting:

```python
fig, ax = plt.subplots()
t = # array/sequence of times
pressures = # array/sequence of pressure samples
ax.plot(t, pressures)
ax.set_ylabel("Pressure [Pa]")
ax.set_xlabel("Time [s]");
```
<!-- #endregion -->

<COGNOTE>
    The time required for one repetition is $T = \frac{1}{f}$, and the number of samples that we take per second is $f_s$, thus
    
\begin{equation}
    N_{samples} = T \times f_s = \frac{f_{s}}{f}
\end{equation}

is the number of samples associated with *one* period of oscillation.
</COGNOTE>  

```python
# <COGINST>
fig, ax = plt.subplots()

# number of samples associated with 4 repetitions
duration = 4 / 261.63  # seconds
sampling_rate = 44100 # Hz
n_samples = int(duration * sampling_rate) + 1

times = np.arange(n_samples) / sampling_rate  # seconds

ax.plot(times, pressure(times, amp=amplitude, freq=freq))
ax.set_xlabel("t (seconds)")
ax.grid("True")
ax.set_ylabel("Pressure [Pa]")
ax.set_xlabel("Time [s]");
# </COGINST>
```

(1.1.4) **Leveraging the principle of superposition**, plot the waveform of the C-major triad for $0.64$ seconds. This should combine three pure tones of equal amplitudes ($0.01 \;\mathrm{Pa}$) of the following respective frequencies:

 - 523.25 Hz (C)
 - 659.25 Hz (E)
 - 783.99 Hz (G)
 
Use the same sampling rate of $44,100\; \mathrm{Hz}$ to determine the times at which you will evaluate this temporal waveform.

```python
# <COGINST>
amp = 0.01  # Pascals
duration = 0.64
sampling_rate = 44100 # Hz
n_samples = int(duration * sampling_rate) + 1

times = np.arange(n_samples) / sampling_rate  # seconds

# the principle of super positions simply states that we combine individual
# components of a sound wave by adding them
chord = (
    pressure(times, amp=amp, freq=523.25)
    + pressure(times, amp=amp, freq=659.25)
    + pressure(times, amp=amp, freq=783.99)
)

fig, ax = plt.subplots()
ax.plot(times, chord)
ax.set_ylabel("Pressure [Pa]")
ax.set_xlabel("Time [s]")
ax.set_title("Major Triad");
# </COGINST>
```

Play the major triad audio clip for $3$ seconds.

```python
# You might want to turn down the volume on your computer a bit

# <COGINST>
amp = 0.01  # Pascals
duration = 3  # seconds
times = np.arange(0, int(sampling_rate * duration) + 1) / sampling_rate  # seconds
chord = (
    pressure(times, amp=amp, freq=523.25)
    + pressure(times, amp=amp, freq=659.25)
    + pressure(times, amp=amp, freq=783.99)
)  # Pascals

Audio(chord, rate=sampling_rate)
# </COGINST>
```

Isn't it beautiful?
Notice how messy looking the waveform is. It is wholly unintuitive to look at the data in this way, even though it is only comprised of $3$ simple notes.
In an upcoming section, we will see that we can convert this *amplitude-time* data into *amplitude-frequency* data, which is much more useful for us!
This conversion process is known as a **Fourier Transform**. 


(1.1.5) Lastly, define a function that describes a pressure wave for **noise**.
That is, use `numpy.random.rand` ([docs](https://numpy.org/doc/stable/reference/random/generated/numpy.random.rand.html)) to generate samples randomly between $0$ and $1$).
Plot some of its temporal waveform for a duration of $0.05$ seconds, using a sampling rate of $44,100$ Hertz.

```python
# <COGINST>
def noise(t):
    return np.random.rand(*t.shape)


fig, ax = plt.subplots()
duration = 0.05  # seconds
times = np.arange(0, int(sampling_rate * duration) + 1)/ sampling_rate  # seconds
ax.plot(times, noise(times))
ax.set_ylabel("Pressure [Pa]")
ax.set_xlabel("Time [s]")
ax.set_title("Noise!");
# </COGINST>
```

Now play 3 seconds of noise!

```python
# <COGINST>
duration = 3
times = np.arange(0, int(sampling_rate * duration) + 1) / sampling_rate
Audio(noise(times), rate=sampling_rate)
# </COGINST>
```
